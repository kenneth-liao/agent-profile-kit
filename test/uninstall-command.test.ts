/**
 * The `uninstall` command matrix (ticket #496, spec #491 US-006/DEC-004):
 * explicit scope is never defaulted, the general confirmation fires on
 * interactive input unless `--auto-confirm` answers it, and every refusal
 * or decline leaves all lifecycle state and output untouched — including a
 * second healthy pending Project. Public-command behavior only.
 *
 * Ticket #497 pins the lone `--profile` path end to end (removal,
 * refusal, fleet-wide interactive review), the composed zero-match
 * outcome, and the single-resolution race under a Profile filter.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, type Readable, type Writable } from "node:stream";

import { runUninstallCommand } from "../cli/uninstall-command.js";
import { executeInstall } from "../installer/install-application.js";
import { readInstallationState } from "../installer/installation-state.js";
import { ordinaryReceipts } from "../installer/ownership-state.js";
import { initializeWorkspace } from "../installer/initialize-workspace.js";

const temporaryDirectories: string[] = [];

function isolatedHome(): string {
  const home = mkdtempSync(join(tmpdir(), "agent-profile-kit-uninstall-command-"));
  temporaryDirectories.push(home);
  return home;
}

function projectDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), "agent-profile-kit-uninstall-cmd-project-"));
  temporaryDirectories.push(path);
  return path;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

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
  readonly output: Writable;
  readonly stderr: Writable;
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

interface StartedUninstall {
  readonly pending: Promise<{ exitCode: 0 | 1 | 2; streams: CapturedStreams }>;
  readonly streams: CapturedStreams;
}

function startUninstall(
  home: string,
  arguments_: readonly string[],
  input: Readable,
  options: { readonly cwd?: string } = {},
): StartedUninstall {
  const streams = capturedStreams();
  const pending = runUninstallCommand({
    home,
    arguments: arguments_,
    stdout: streams.output as Writable & { isTTY?: boolean },
    stderr: streams.stderr as Writable & { isTTY?: boolean },
    input,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
  }).then((outcome) => ({ exitCode: outcome.exitCode, streams }));
  return { pending, streams };
}

async function runUninstall(
  home: string,
  arguments_: readonly string[],
  input: Readable,
  options: { readonly cwd?: string } = {},
): Promise<{ exitCode: 0 | 1 | 2; streams: CapturedStreams }> {
  const streams = capturedStreams();
  const outcome = await runUninstallCommand({
    home,
    arguments: arguments_,
    stdout: streams.output as Writable & { isTTY?: boolean },
    stderr: streams.stderr as Writable & { isTTY?: boolean },
    input,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
  });
  return { exitCode: outcome.exitCode, streams };
}

async function setupInstalledPair(): Promise<{
  readonly home: string;
  readonly first: string;
  readonly second: string;
  readonly firstOutput: string;
}> {
  const home = await setupHome();
  const first = projectDirectory();
  const second = projectDirectory();
  await executeInstall(home, { profile: "engineering", hosts: ["codex"], project: first });
  await executeInstall(home, { profile: "engineering", hosts: ["codex"], project: second });
  const state = await readInstallationState(home);
  const { realpathSync } = await import("node:fs");
  const receipt = ordinaryReceipts(state).find((entry) => entry.project === realpathSync(first));
  if (receipt === undefined || receipt.outputs.length === 0) {
    throw new Error("fixture install produced no output");
  }
  return { home, first, second, firstOutput: join(first, receipt.outputs[0]!.path) };
}

async function setupMixedProfilePair(): Promise<{
  readonly home: string;
  readonly first: string;
  readonly second: string;
  readonly firstOutput: string;
  readonly secondOutput: string;
}> {
  const home = await setupHome();
  writeProfile(home, "docs");
  const first = projectDirectory();
  const second = projectDirectory();
  await executeInstall(home, { profile: "engineering", hosts: ["codex"], project: first });
  await executeInstall(home, { profile: "docs", hosts: ["codex"], project: second });
  const state = await readInstallationState(home);
  const { realpathSync } = await import("node:fs");
  const firstReceipt = ordinaryReceipts(state).find((entry) => entry.project === realpathSync(first));
  const secondReceipt = ordinaryReceipts(state).find((entry) => entry.project === realpathSync(second));
  if (firstReceipt === undefined || firstReceipt.outputs.length === 0) {
    throw new Error("fixture install produced no output");
  }
  if (secondReceipt === undefined || secondReceipt.outputs.length === 0) {
    throw new Error("fixture install produced no output");
  }
  return {
    home,
    first,
    second,
    firstOutput: join(first, firstReceipt.outputs[0]!.path),
    secondOutput: join(second, secondReceipt.outputs[0]!.path),
  };
}

function snapshotUntouched(home: string, first: string, firstOutput: string): void {
  expect(readFileSync(configPath(home), "utf8")).toContain(first);
  expect(existsSync(firstOutput)).toBe(true);
}

function snapshotMixedUntouched(
  home: string,
  first: string,
  firstOutput: string,
  second: string,
  secondOutput: string,
): void {
  expect(readFileSync(configPath(home), "utf8")).toContain(first);
  expect(readFileSync(configPath(home), "utf8")).toContain(second);
  expect(existsSync(firstOutput)).toBe(true);
  expect(existsSync(secondOutput)).toBe(true);
}

describe("uninstall confirmation matrix", () => {
  test("non-interactive scope without --auto-confirm refuses with zero writes", async () => {
    const { home, first, firstOutput } = await setupInstalledPair();
    const result = await runUninstall(home, ["--all"], nonInteractiveInput());
    expect(result.exitCode).toBe(1);
    expect(plain(result.streams.errorText())).toContain("--auto-confirm");
    snapshotUntouched(home, first, firstOutput);
  });

  test("absent non-interactive scope never implies all Projects", async () => {
    const { home, first, firstOutput } = await setupInstalledPair();
    const result = await runUninstall(home, ["--auto-confirm"], nonInteractiveInput());
    expect(result.exitCode).toBe(1);
    expect(plain(result.streams.errorText())).toContain("--all");
    snapshotUntouched(home, first, firstOutput);
  });

  test("bare interactive uninstall opens Project selection instead of refusing", async () => {
    // Ticket #499 replaces the bare-interactive refusal with the picker
    // flow: the picker opens with zero writes, and cancelling it changes
    // nothing (full picker behavior lives in uninstall-search.test.ts).
    const { home, first, firstOutput } = await setupInstalledPair();
    const input = fakeInteractiveInput();
    const started = startUninstall(home, [], input);
    await waitForOutput(started.streams.humanText, "Which Projects");
    input.end();
    const result = await started.pending;
    expect(result.exitCode).toBe(1);
    expect(plain(started.streams.errorText())).toContain("cancelled");
    snapshotUntouched(home, first, firstOutput);
  });

  test("declining the general confirmation leaves everything untouched", async () => {
    const { home, first, firstOutput } = await setupInstalledPair();
    const input = fakeInteractiveInput();
    const started = startUninstall(home, ["--all"], input);
    await waitForOutput(started.streams.humanText, "Uninstall as listed?");
    input.write("n\n");
    const result = await started.pending;
    expect(result.exitCode).toBe(1);
    expect(plain(started.streams.errorText())).toContain("nothing was written");
    // A declined uninstall is a retained cancellation (DEC-008), so its
    // detail route follows the diagnostic on stderr (ADR-0040).
    expect(plain(started.streams.errorText())).toContain("Details: apkit details");
    expect(plain(started.streams.humanText())).not.toContain("Details:");
    snapshotUntouched(home, first, firstOutput);
  });

  test("accepting the general confirmation removes the selected scope", async () => {
    const { home, first, second, firstOutput } = await setupInstalledPair();
    const input = fakeInteractiveInput();
    const started = startUninstall(home, ["--project", first], input);
    await waitForOutput(started.streams.humanText, "Uninstall as listed?");
    input.write("y\n");
    const result = await started.pending;
    expect(result.exitCode).toBe(0);
    expect(existsSync(firstOutput)).toBe(false);
    expect(readFileSync(configPath(home), "utf8")).not.toContain(first);
    expect(readFileSync(configPath(home), "utf8")).toContain(second);
  });

  test("--here selects the containing bound Project", async () => {
    const { home, first, second } = await setupInstalledPair();
    const { mkdirSync } = await import("node:fs");
    const descendant = `${first}/src/nested`;
    mkdirSync(descendant, { recursive: true });
    const result = await runUninstall(home, ["--here", "--auto-confirm"], nonInteractiveInput(), {
      cwd: descendant,
    });
    expect(result.exitCode).toBe(0);
    expect(readFileSync(configPath(home), "utf8")).not.toContain(first);
    expect(readFileSync(configPath(home), "utf8")).toContain(second);
  });

  test("a binding added between confirmation and commit is never removed unshown", async () => {
    const { home, first, firstOutput } = await setupInstalledPair();
    const input = fakeInteractiveInput();
    const started = startUninstall(home, ["--all"], input);
    await waitForOutput(started.streams.humanText, "Uninstall as listed?");
    // A concurrent installation lands after the review was shown.
    const added = projectDirectory();
    const before = readFileSync(configPath(home), "utf8");
    writeFileSync(
      configPath(home),
      `${before.trimEnd()}\n  - project: ${added}\n    profile: engineering\n    hosts: [codex]\n`,
    );
    input.write("y\n");
    const result = await started.pending;
    expect(result.exitCode).toBe(1);
    expect(plain(started.streams.errorText())).toContain("scope changed during confirmation");
    // The printed retry must not carry --auto-confirm: following it reviews
    // the changed scope instead of removing it unseen (RE-1).
    expect(plain(started.streams.errorText())).toContain("uninstall --all");
    expect(plain(started.streams.errorText())).not.toContain("--auto-confirm");
    // Zero writes: the reviewed scope and the added binding both survive.
    snapshotUntouched(home, first, firstOutput);
    expect(readFileSync(configPath(home), "utf8")).toContain(added);
  });

  test("--json parse refusals use the versioned envelope without prose", async () => {
    const { home } = await setupInstalledPair();
    const badFlag = await runUninstall(home, ["--bogus", "--json"], nonInteractiveInput());
    expect(badFlag.exitCode).toBe(1);
    expect(badFlag.streams.errorText()).toBe("");
    const badPayload = JSON.parse(badFlag.streams.humanText()) as {
      schemaVersion: number;
      command: string;
      outcome: string;
      error: string;
    };
    expect(badPayload.schemaVersion).toBe(15);
    expect(badPayload.command).toBe("uninstall");
    expect(badPayload.outcome).toBe("error");
    expect(badPayload.error).toContain("--bogus");

    // `--host` alone names no scope (DEC-003): the refusal carries the
    // missing-scope envelope with zero writes, not a flag rejection.
    const hostFlag = await runUninstall(home, ["--host", "codex", "--json"], nonInteractiveInput());
    expect(hostFlag.exitCode).toBe(1);
    const hostPayload = JSON.parse(hostFlag.streams.humanText()) as { error: string };
    expect(hostPayload.error).toContain("explicit scope");
  });

  test("--json refusals use the versioned envelope without prose", async () => {
    const { home } = await setupInstalledPair();
    const missingScope = await runUninstall(home, ["--json"], nonInteractiveInput());
    expect(missingScope.exitCode).toBe(1);
    const missingPayload = JSON.parse(missingScope.streams.humanText()) as {
      schemaVersion: number;
      command: string;
      outcome: string;
      error: string;
    };
    expect(missingPayload.schemaVersion).toBe(15);
    expect(missingPayload.command).toBe("uninstall");
    expect(missingPayload.outcome).toBe("error");
    expect(missingPayload.error).toContain("explicit scope");

    const needsConfirm = await runUninstall(home, ["--all", "--json"], nonInteractiveInput());
    expect(needsConfirm.exitCode).toBe(1);
    const confirmPayload = JSON.parse(needsConfirm.streams.humanText()) as { outcome: string; error: string };
    expect(confirmPayload.outcome).toBe("error");
    expect(confirmPayload.error).toContain("confirmation");
  });

  test("TTY plus --json refuses the missing scope as machine JSON without prompting", async () => {
    // PROD-4 (ticket #499): the interactive picker branch requires a TTY
    // *without* --json, so a TTY carrying --json still refuses through the
    // versioned envelope and never opens the picker.
    const { home, first, firstOutput } = await setupInstalledPair();
    const input = fakeInteractiveInput();
    const result = await runUninstall(home, ["--json"], input);
    expect(result.exitCode).toBe(1);
    expect(result.streams.errorText()).toBe("");
    const payload = JSON.parse(result.streams.humanText()) as {
      schemaVersion: number;
      command: string;
      outcome: string;
      error: string;
    };
    expect(payload.schemaVersion).toBe(15);
    expect(payload.command).toBe("uninstall");
    expect(payload.outcome).toBe("error");
    expect(payload.error).toContain("explicit scope");
    expect(plain(result.streams.humanText())).not.toContain("Which Projects");
    snapshotUntouched(home, first, firstOutput);
  });

  test("--json success carries schemaVersion and outcome", async () => {
    const { home, first } = await setupInstalledPair();
    const result = await runUninstall(home, ["--project", first, "--auto-confirm", "--json"], nonInteractiveInput());
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.streams.humanText()) as {
      schemaVersion: number;
      command: string;
      outcome: string;
      completed: { project: string }[];
      skipped: unknown[];
      unattempted: unknown[];
    };
    expect(payload.schemaVersion).toBe(15);
    expect(payload.command).toBe("uninstall");
    expect(payload.outcome).toBe("clean");
    expect(payload.completed.map((entry) => entry.project)).toEqual([first]);
    expect(payload.skipped).toEqual([]);
    expect(payload.unattempted).toEqual([]);
  });

  test("--json confirmation refusal carries empty progress without prose", async () => {
    const { home } = await setupInstalledPair();
    const input = fakeInteractiveInput();
    const started = startUninstall(home, ["--all", "--json"], input);
    // JSON never prompts: the confirmation refusal carries no progress writes.
    const result = await started.pending;
    expect(result.exitCode).toBe(1);
    const payload = JSON.parse(started.streams.humanText()) as {
      outcome: string;
      completed: unknown[];
      unattempted: unknown[];
    };
    expect(payload.outcome).toBe("error");
    expect(payload.completed).toEqual([]);
  });

  test("zero-match Profile scope reports no match with no writes", async () => {
    const { home, first, firstOutput } = await setupInstalledPair();
    const result = await runUninstall(
      home,
      ["--profile", "unknown-profile", "--auto-confirm"],
      nonInteractiveInput(),
    );
    expect(result.exitCode).toBe(1);
    expect(plain(result.streams.errorText())).toContain("unknown-profile");
    snapshotUntouched(home, first, firstOutput);
  });

  test("lone --profile removes only installations using that Profile", async () => {
    const { home, first, second, secondOutput } = await setupMixedProfilePair();
    const result = await runUninstall(
      home,
      ["--profile", "engineering", "--auto-confirm"],
      nonInteractiveInput(),
    );
    expect(result.exitCode).toBe(0);
    expect(readFileSync(configPath(home), "utf8")).not.toContain(first);
    expect(readFileSync(configPath(home), "utf8")).toContain(second);
    expect(existsSync(secondOutput)).toBe(true);
  });

  test("lone --profile without --auto-confirm refuses on non-interactive input", async () => {
    const { home, first, firstOutput, second, secondOutput } = await setupMixedProfilePair();
    const result = await runUninstall(home, ["--profile", "engineering"], nonInteractiveInput());
    expect(result.exitCode).toBe(1);
    expect(plain(result.streams.errorText())).toContain("--auto-confirm");
    // The refusal names the Profile-scoped retry (not the missing-scope
    // shape): dropping the filter from scope detection must flip this test.
    expect(plain(result.streams.errorText())).toContain("--profile");
    snapshotMixedUntouched(home, first, firstOutput, second, secondOutput);
  });

  test("interactive lone --profile reviews the fleet-wide Profile scope", async () => {
    const { home, first, second, secondOutput } = await setupMixedProfilePair();
    const input = fakeInteractiveInput();
    const started = startUninstall(home, ["--profile", "engineering"], input);
    await waitForOutput(
      started.streams.humanText,
      "every installation using Profile 'engineering' (fleet-wide)",
    );
    await waitForOutput(started.streams.humanText, "Uninstall as listed?");
    input.write("y\n");
    const result = await started.pending;
    expect(result.exitCode).toBe(0);
    expect(readFileSync(configPath(home), "utf8")).not.toContain(first);
    expect(readFileSync(configPath(home), "utf8")).toContain(second);
    expect(existsSync(secondOutput)).toBe(true);
  });

  test("composed --project --profile match removes exactly that installation", async () => {
    const { home, first, second, firstOutput, secondOutput } = await setupMixedProfilePair();
    const result = await runUninstall(
      home,
      ["--project", first, "--profile", "engineering", "--auto-confirm"],
      nonInteractiveInput(),
    );
    expect(result.exitCode).toBe(0);
    expect(readFileSync(configPath(home), "utf8")).not.toContain(first);
    expect(readFileSync(configPath(home), "utf8")).toContain(second);
    expect(existsSync(firstOutput)).toBe(false);
    expect(existsSync(secondOutput)).toBe(true);
  });

  test("composed --project --profile mismatch reports no match with no writes", async () => {
    const { home, first, firstOutput, second, secondOutput } = await setupMixedProfilePair();
    const result = await runUninstall(
      home,
      ["--project", first, "--profile", "docs", "--auto-confirm"],
      nonInteractiveInput(),
    );
    expect(result.exitCode).toBe(1);
    expect(plain(result.streams.errorText())).toContain("docs");
    expect(plain(result.streams.errorText())).toContain("within the selected scope");
    snapshotMixedUntouched(home, first, firstOutput, second, secondOutput);
  });

  test("a matching binding added during Profile confirmation is never removed unshown", async () => {
    const { home, first, firstOutput, second, secondOutput } = await setupMixedProfilePair();
    const input = fakeInteractiveInput();
    const started = startUninstall(home, ["--profile", "engineering"], input);
    await waitForOutput(started.streams.humanText, "Uninstall as listed?");
    // A concurrent installation using the filtered Profile lands after review.
    const added = projectDirectory();
    const before = readFileSync(configPath(home), "utf8");
    writeFileSync(
      configPath(home),
      `${before.trimEnd()}\n  - project: ${added}\n    profile: engineering\n    hosts: [codex]\n`,
    );
    input.write("y\n");
    const result = await started.pending;
    expect(result.exitCode).toBe(1);
    expect(plain(started.streams.errorText())).toContain("scope changed during confirmation");
    // The retry reviews the changed Profile scope instead of removing it unseen.
    expect(plain(started.streams.errorText())).toContain("uninstall --profile engineering");
    expect(plain(started.streams.errorText())).not.toContain("--auto-confirm");
    // Zero writes: the reviewed scope and the added binding both survive.
    snapshotMixedUntouched(home, first, firstOutput, second, secondOutput);
    expect(readFileSync(configPath(home), "utf8")).toContain(added);
  });

  test("a profile change between confirmation and commit fails closed under a non-profile scope", async () => {
    const { home, first, second, firstOutput, secondOutput } = await setupMixedProfilePair();
    const input = fakeInteractiveInput();
    const started = startUninstall(home, ["--project", first], input);
    await waitForOutput(started.streams.humanText, "Uninstall as listed?");
    // A concurrent writer retargets the reviewed installation to another
    // Profile. Only the first binding uses engineering, so the first
    // occurrence is exactly its line; a missed anchor leaves exit 0 and
    // fails this test loudly instead of passing vacuously.
    const before = readFileSync(configPath(home), "utf8");
    writeFileSync(configPath(home), before.replace("profile: engineering", "profile: docs"));
    input.write("y\n");
    const result = await started.pending;
    // The reviewed-preview comparison (whose scope key carries the profile)
    // refuses before any write — never the under-lock concurrent-change path.
    expect(result.exitCode).toBe(1);
    expect(plain(started.streams.errorText())).toContain("scope changed during confirmation");
    expect(plain(started.streams.errorText())).not.toContain("--auto-confirm");
    // Zero lifecycle writes: both installations keep their output and the
    // concurrent retarget is left untouched.
    expect(existsSync(firstOutput)).toBe(true);
    expect(existsSync(secondOutput)).toBe(true);
    expect(readFileSync(configPath(home), "utf8")).toContain(first);
    expect(readFileSync(configPath(home), "utf8")).toContain(second);
  });

  test("unbound Project scope fails before any write", async () => {
    const { home, first, firstOutput } = await setupInstalledPair();
    const other = projectDirectory();
    const result = await runUninstall(
      home,
      ["--project", other, "--auto-confirm"],
      nonInteractiveInput(),
    );
    expect(result.exitCode).toBe(1);
    snapshotUntouched(home, first, firstOutput);
  });
});

describe("uninstall completed-operation detail route (US-011, DEC-007, ADR-0040)", () => {
  test("a successful full uninstall prints the count once and the retained route", async () => {
    const { home, first, firstOutput } = await setupInstalledPair();

    const result = await runUninstall(
      home,
      ["--project", first, "--auto-confirm"],
      nonInteractiveInput(),
    );

    expect(result.exitCode).toBe(0);
    expect(existsSync(firstOutput)).toBe(false);
    const text = plain(result.streams.humanText());
    expect(text).toContain("Removed proven Agent Profile Kit-owned output from 1 Project");
    expect(text).toContain("Details: apkit details");
  });

  test("a zero-match scope prints no detail route", async () => {
    const { home, first, firstOutput } = await setupInstalledPair();

    const result = await runUninstall(
      home,
      ["--profile", "unknown-profile", "--auto-confirm"],
      nonInteractiveInput(),
    );

    expect(result.exitCode).toBe(1);
    expect(plain(result.streams.humanText())).not.toContain("Details:");
    expect(plain(result.streams.errorText())).not.toContain("Details:");
    snapshotUntouched(home, first, firstOutput);
  });
});
