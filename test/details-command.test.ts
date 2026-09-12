/**
 * Bounded lifecycle operation history (ticket #501, spec #491 US-012,
 * DEC-007/DEC-008/DEC-012, TEST-006): the public install/update/uninstall
 * commands retain structured outcome evidence, and `apkit details` reads it
 * back — latest, compact list, one identity, or JSON — without repeating any
 * lifecycle write.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, type Writable } from "node:stream";

import { runApplyCommand } from "../cli/apply-command.js";
import {
  beginLifecycleOperationRecording,
  finishLifecycleOperationRecording,
  installFailureRecording,
  lateAuthorizationStopRecording,
} from "../cli/operation-recording.js";
import { InstallExecutionError } from "../installer/install-application.js";
import { runDetailsCommand, type DetailsCommandRequest } from "../cli/details-command.js";
import { runInstallCommand } from "../cli/install-command.js";
import { runUninstallCommand } from "../cli/uninstall-command.js";
import { initializeWorkspace } from "../installer/initialize-workspace.js";
import { statusApplication } from "../installer/commands.js";
import {
  appendOperationHistory,
  operationHistoryPath,
  readOperationHistory,
  type OperationHistoryEntry,
} from "../installer/operation-history.js";
import type { ProjectBindingSelection } from "../installer/local-configuration.js";
import type { InteractiveExecution } from "../cli/pager.js";
import { humanText } from "./support/human-text.js";

const temporaryDirectories: string[] = [];

function track<T extends string>(path: T): T {
  temporaryDirectories.push(path);
  return path;
}

function isolatedHome(): string {
  return track(mkdtempSync(join(tmpdir(), "agent-profile-kit-details-test-")));
}

function projectDirectory(prefix = "agent-profile-kit-details-project-"): string {
  return track(mkdtempSync(join(tmpdir(), prefix)));
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

async function setupHome(): Promise<string> {
  const home = isolatedHome();
  await initializeWorkspace(home);
  mkdirSync(join(workspacePath(home), "context"), { recursive: true });
  writeFileSync(
    join(workspacePath(home), "context", "team-rules.md"),
    "---\nid: team-rules\ndependencies: []\n---\nAlways preserve the project boundary.\n",
  );
  mkdirSync(join(workspacePath(home), "profiles"), { recursive: true });
  writeFileSync(
    join(workspacePath(home), "profiles", "coding.yaml"),
    "id: coding\ncontext:\n  - team-rules\nskills: []\n",
  );
  writeFileSync(
    configPath(home),
    `schema_version: 2\nworkspace: ${workspacePath(home)}\nbindings: []\n`,
  );
  return home;
}

interface CapturedStreams {
  readonly output: Writable & { isTTY?: boolean };
  readonly stderr: Writable & { isTTY?: boolean };
  readonly humanText: () => string;
  readonly errorText: () => string;
}

function capturedStreams(interactive = false): CapturedStreams {
  const chunks: Buffer[] = [];
  const errorChunks: Buffer[] = [];
  const output = new PassThrough() as PassThrough & { isTTY?: boolean };
  const stderr = new PassThrough() as PassThrough & { isTTY?: boolean };
  output.on("data", (chunk: Buffer) => chunks.push(chunk));
  stderr.on("data", (chunk: Buffer) => errorChunks.push(chunk));
  if (interactive) {
    output.isTTY = true;
    stderr.isTTY = true;
  }
  return {
    output,
    stderr,
    humanText: () => Buffer.concat(chunks).toString(),
    errorText: () => Buffer.concat(errorChunks).toString(),
  };
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
  text: () => string,
  fragment: string,
  deadlineMs = 5000,
): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (!humanText(text()).includes(fragment)) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for output fragment: ${fragment}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

interface Invocation<T> {
  readonly outcome: Promise<T>;
  readonly streams: CapturedStreams;
}

function invokeInstall(
  home: string,
  arguments_: readonly string[],
  input: PassThrough = nonInteractiveInput(),
  interactive = false,
): Invocation<{ readonly exitCode: 0 | 1 | 2 }> {
  const streams = capturedStreams(interactive);
  return {
    outcome: runInstallCommand({
      home,
      arguments: arguments_,
      stdout: streams.output,
      stderr: streams.stderr,
      input,
    }),
    streams,
  };
}

function invokeUninstall(
  home: string,
  arguments_: readonly string[],
  input: PassThrough = nonInteractiveInput(),
  interactive = false,
): Invocation<{ readonly exitCode: 0 | 1 | 2 }> {
  const streams = capturedStreams(interactive);
  return {
    outcome: runUninstallCommand({
      home,
      arguments: arguments_,
      stdout: streams.output,
      stderr: streams.stderr,
      input,
    }),
    streams,
  };
}

/** Mirrors the packed CLI's update scope parsing for the arguments used here. */
function updateSelection(arguments_: readonly string[]): ProjectBindingSelection {
  const filter = arguments_.includes("--stale")
    ? "stale" as const
    : arguments_.includes("--blocked")
      ? "blocked" as const
      : undefined;
  const projectArgument = arguments_.find((argument) => !argument.startsWith("-"));
  if (projectArgument === undefined) {
    return filter === undefined ? { kind: "all" } : { kind: "all", filter };
  }
  return {
    command: "update",
    kind: "project",
    match: "exact",
    target: projectArgument,
    ...(filter === undefined ? {} : { filter }),
  };
}

function invokeUpdate(
  home: string,
  arguments_: readonly string[],
  input: PassThrough = nonInteractiveInput(),
  interactive = false,
): Invocation<{ readonly exitCode: 0 | 1 | 2 }> {
  const streams = capturedStreams(interactive);
  return {
    outcome: runApplyCommand({
      home,
      selection: updateSelection(arguments_),
      json: arguments_.includes("--json"),
      removeChanged: arguments_.includes("--remove-changed"),
      replaceChanged: arguments_.includes("--replace-changed"),
      verbose: false,
      stdout: streams.output,
      stderr: streams.stderr,
      input,
    }),
    streams,
  };
}

async function readDetails(
  home: string,
  arguments_: readonly string[],
  options: Partial<Pick<DetailsCommandRequest, "pagerExecution" | "pagerEnvironment">> = {},
): Promise<{ readonly exitCode: number; readonly output: string; readonly error: string }> {
  const streams = capturedStreams(arguments_.includes("--json") ? false : process.stdout.isTTY === true);
  const outcome = await runDetailsCommand({
    home,
    arguments: arguments_,
    stdout: streams.output,
    stderr: streams.stderr,
    ...options,
  });
  return { exitCode: outcome.exitCode, output: streams.humanText(), error: streams.errorText() };
}

async function detailsEntries(
  home: string,
  arguments_: readonly string[] = ["--list"],
): Promise<readonly OperationHistoryEntry[]> {
  const result = await readDetails(home, [...arguments_, "--json"]);
  expect(result.exitCode).toBe(0);
  return (JSON.parse(result.output) as { entries: readonly OperationHistoryEntry[] }).entries;
}

function historyBytes(home: string): string {
  return readFileSync(operationHistoryPath(home), "utf8");
}

describe("lifecycle operation recording", () => {
  test("install records the committed generated work, and details reads it back", async () => {
    const home = await setupHome();
    const projectPath = projectDirectory();
    const install = invokeInstall(home, ["coding", projectPath, "--host", "codex", "--auto-confirm"]);
    expect((await install.outcome).exitCode).toBe(0);

    const entries = await detailsEntries(home);
    expect(entries).toHaveLength(1);
    const entry = entries[0]!;
    expect(entry.id).toBe("op-000001");
    expect(entry.command).toBe("install");
    expect(entry.outcome).toBe("succeeded");
    expect(entry.scope).toEqual({ selection: "project", profile: "coding", hosts: ["codex"] });
    expect(Number.isNaN(Date.parse(entry.startedAt))).toBe(false);
    expect(entry.projects).toHaveLength(1);
    expect(entry.projects[0]!.written).toEqual([
      ".agent-profile-kit/codex/context.md",
      ".codex/hooks.json",
    ]);
    // Committed evidence is paths only: never generated file contents.
    expect(historyBytes(home)).not.toContain("Always preserve the project boundary.");

    const latest = await readDetails(home, []);
    expect(latest.exitCode).toBe(0);
    expect(humanText(latest.output)).toContain("Install op-000001");
    expect(humanText(latest.output)).toContain(".codex/hooks.json");

    const byId = await readDetails(home, [entry.id]);
    expect(byId.exitCode).toBe(0);
    expect(humanText(byId.output)).toContain("Install op-000001");
    expect(humanText(byId.output)).toContain(".agent-profile-kit/codex/context.md");
  });

  test("details never reruns lifecycle writes", async () => {
    const home = await setupHome();
    const projectPath = projectDirectory();
    expect((await invokeInstall(home, ["coding", projectPath, "--host", "codex", "--auto-confirm"]).outcome).exitCode).toBe(0);
    const outputPath = join(projectPath, ".codex", "hooks.json");
    const before = readFileSync(outputPath, "utf8");

    for (const arguments_ of [[], ["--list"], ["op-000001"], ["--json"]]) {
      expect((await readDetails(home, arguments_)).exitCode).toBe(0);
    }
    expect(readFileSync(outputPath, "utf8")).toBe(before);
    expect(existsSync(join(projectPath, ".agent-profile-kit", "codex", "context.md"))).toBe(true);
  });

  test("retrieval survives later filesystem state: the install entry keeps its evidence after uninstall", async () => {
    const home = await setupHome();
    const projectPath = projectDirectory();
    expect((await invokeInstall(home, ["coding", projectPath, "--host", "codex", "--auto-confirm"]).outcome).exitCode).toBe(0);
    expect((await invokeUninstall(home, ["--all", "--auto-confirm"]).outcome).exitCode).toBe(0);
    expect(existsSync(join(projectPath, ".codex", "hooks.json"))).toBe(false);

    const entries = await detailsEntries(home);
    expect(entries.map((entry) => entry.command)).toEqual(["uninstall", "install"]);
    const installEntry = entries.find((entry) => entry.command === "install")!;
    expect(installEntry.outcome).toBe("succeeded");
    expect(installEntry.projects[0]!.written).toEqual([
      ".agent-profile-kit/codex/context.md",
      ".codex/hooks.json",
    ]);
    const rendered = await readDetails(home, [installEntry.id]);
    expect(humanText(rendered.output)).toContain(".codex/hooks.json");
  });

  test("a routine no-op update records no-op with the requested fleet scope", async () => {
    const home = await setupHome();
    const projectPath = projectDirectory();
    expect((await invokeInstall(home, ["coding", projectPath, "--host", "codex", "--auto-confirm"]).outcome).exitCode).toBe(0);
    expect((await invokeUpdate(home, ["--all"]).outcome).exitCode).toBe(0);

    const latest = (await detailsEntries(home))[0]!;
    expect(latest.command).toBe("update");
    expect(latest.outcome).toBe("no-op");
    expect(latest.scope).toEqual({ selection: "all" });
    expect(latest.projects[0]!.result).toBe("unchanged");
  });

  test("a declined general confirmation records a cancelled entry with zero writes", async () => {
    const home = await setupHome();
    const projectPath = projectDirectory();
    const input = fakeInteractiveInput();
    const install = invokeInstall(home, ["coding", projectPath, "--host", "codex"], input, true);
    await waitForOutput(install.streams.humanText, "(y/N)");
    input.write("n\n");
    expect((await install.outcome).exitCode).toBe(1);

    const entry = (await detailsEntries(home))[0]!;
    expect(entry.outcome).toBe("cancelled");
    expect(entry.cancelledReason).toBe("declined");
    expect(entry.projects[0]!.result).toBe("unattempted");
    expect(entry.projects[0]!.written).toBeUndefined();
    expect(readFileSync(configPath(home), "utf8")).toContain("bindings: []");
    expect(existsSync(join(projectPath, ".agent-profile-kit"))).toBe(false);
  });

  test("a declined changed-file consent records a cancelled update with reviewed outputs", async () => {
    const home = await setupHome();
    const projectPath = projectDirectory();
    expect((await invokeInstall(home, ["coding", projectPath, "--host", "codex", "--auto-confirm"]).outcome).exitCode).toBe(0);
    // Independently change a generated file so the next update must consent.
    writeFileSync(join(projectPath, ".codex", "hooks.json"), "{}\n");

    const input = fakeInteractiveInput();
    const update = invokeUpdate(home, ["--all"], input, true);
    await waitForOutput(update.streams.humanText, "(y/N)");
    input.write("n\n");
    expect((await update.outcome).exitCode).toBe(1);

    const latest = (await detailsEntries(home))[0]!;
    expect(latest.command).toBe("update");
    expect(latest.outcome).toBe("cancelled");
    expect(latest.cancelledReason).toBe("declined");
    expect(latest.reviewedChangedOutputs?.map((record) => record.path)).toEqual([".codex/hooks.json"]);
    expect(latest.projects[0]!.result).toBe("unattempted");
    expect(readFileSync(join(projectPath, ".codex", "hooks.json"), "utf8")).toBe("{}\n");
  });

  test("a declined changed-file consent records a cancelled install with reviewed outputs", async () => {
    const home = await setupHome();
    const projectPath = projectDirectory();
    expect((await invokeInstall(home, ["coding", projectPath, "--host", "codex", "--auto-confirm"]).outcome).exitCode).toBe(0);
    // Re-installing the same selection would replace an independently changed
    // generated file, so the shared consent gate fires.
    writeFileSync(join(projectPath, ".codex", "hooks.json"), "{}\n");

    const input = fakeInteractiveInput();
    const install = invokeInstall(home, ["coding", projectPath, "--host", "codex"], input, true);
    await waitForOutput(install.streams.humanText, "Install as listed?");
    input.write("y\n");
    await waitForOutput(install.streams.humanText, "Replace or delete these generated files");
    input.write("n\n");
    expect((await install.outcome).exitCode).toBe(1);

    const latest = (await detailsEntries(home))[0]!;
    expect(latest.command).toBe("install");
    expect(latest.outcome).toBe("cancelled");
    expect(latest.cancelledReason).toBe("declined");
    expect(latest.reviewedChangedOutputs?.map((record) => record.path)).toEqual([".codex/hooks.json"]);
    expect(latest.projects[0]!.result).toBe("unattempted");
    expect(readFileSync(join(projectPath, ".codex", "hooks.json"), "utf8")).toBe("{}\n");
  });

  test("a declined uninstall confirmation records a cancelled entry with nothing removed", async () => {
    const home = await setupHome();
    const projectPath = projectDirectory();
    expect((await invokeInstall(home, ["coding", projectPath, "--host", "codex", "--auto-confirm"]).outcome).exitCode).toBe(0);

    const input = fakeInteractiveInput();
    const uninstall = invokeUninstall(home, ["--all"], input, true);
    await waitForOutput(uninstall.streams.humanText, "(y/N)");
    input.write("n\n");
    expect((await uninstall.outcome).exitCode).toBe(1);

    const latest = (await detailsEntries(home))[0]!;
    expect(latest.command).toBe("uninstall");
    expect(latest.outcome).toBe("cancelled");
    expect(latest.cancelledReason).toBe("declined");
    expect(latest.projects[0]!.result).toBe("unattempted");
    expect(existsSync(join(projectPath, ".codex", "hooks.json"))).toBe(true);
  });

  test("a declined changed-file consent records a cancelled uninstall with reviewed outputs", async () => {
    const home = await setupHome();
    const projectPath = projectDirectory();
    expect((await invokeInstall(home, ["coding", projectPath, "--host", "codex", "--auto-confirm"]).outcome).exitCode).toBe(0);
    writeFileSync(join(projectPath, ".codex", "hooks.json"), "{}\n");

    const input = fakeInteractiveInput();
    const uninstall = invokeUninstall(home, ["--all", "--auto-confirm"], input, true);
    await waitForOutput(uninstall.streams.humanText, "(y/N)");
    input.write("n\n");
    expect((await uninstall.outcome).exitCode).toBe(1);

    const latest = (await detailsEntries(home))[0]!;
    expect(latest.command).toBe("uninstall");
    expect(latest.outcome).toBe("cancelled");
    expect(latest.cancelledReason).toBe("declined");
    expect(latest.reviewedChangedOutputs?.map((record) => record.path)).toEqual([".codex/hooks.json"]);
    expect(existsSync(join(projectPath, ".codex", "hooks.json"))).toBe(true);
    expect(readFileSync(configPath(home), "utf8")).toContain("coding");
  });

  test("a successful consented update records the reviewed changed-output identities", async () => {
    const home = await setupHome();
    const projectPath = projectDirectory();
    expect((await invokeInstall(home, ["coding", projectPath, "--host", "codex", "--auto-confirm"]).outcome).exitCode).toBe(0);
    writeFileSync(join(projectPath, ".codex", "hooks.json"), "{}\n");

    const input = fakeInteractiveInput();
    const update = invokeUpdate(home, ["--all"], input, true);
    await waitForOutput(update.streams.humanText, "(y/N)");
    input.write("y\n");
    expect((await update.outcome).exitCode).toBe(0);

    const latest = (await detailsEntries(home))[0]!;
    expect(latest.command).toBe("update");
    expect(latest.outcome).toBe("succeeded");
    expect(latest.projects[0]!.result).toBe("completed");
    expect(latest.reviewedChangedOutputs?.map((record) => record.path)).toEqual([".codex/hooks.json"]);
    expect(latest.reviewedChangedOutputs?.[0]!.reviewId).toBeDefined();
  });

  test("a mixed fleet records succeeded when every selected Project committed its work", async () => {
    const home = await setupHome();
    const parent = projectDirectory("agent-profile-kit-details-mixed-");
    const drifting = join(parent, "a-drifting");
    const current = join(parent, "b-current");
    mkdirSync(drifting);
    mkdirSync(current);
    for (const project of [drifting, current]) {
      expect((await invokeInstall(home, ["coding", project, "--host", "codex", "--auto-confirm"]).outcome).exitCode).toBe(0);
    }
    // One Project needs output, the other is settled: the run still succeeded.
    writeFileSync(join(drifting, ".codex", "hooks.json"), "{}\n");
    expect((await invokeUpdate(home, ["--all", "--replace-changed"]).outcome).exitCode).toBe(0);

    const latest = (await detailsEntries(home))[0]!;
    expect(latest.outcome).toBe("succeeded");
    const results = latest.projects.map((project) => project.result).sort();
    expect(results).toEqual(["completed", "unchanged"]);
  });

  test("a post-verify concurrent-change stop records that generated output was committed", () => {
    const facts = installFailureRecording(
      new InstallExecutionError({
        cause: new Error("the recorded selection changed before publication"),
        selectionRestored: false,
        outputCommitted: true,
        concurrentSelectionChange: true,
      }),
      {
        canonicalProject: "/tmp/concurrent-project",
        project: "/tmp/concurrent-project",
        profile: "coding",
        hosts: ["codex"],
      },
    );
    expect(facts?.outcome).toBe("failed");
    expect(facts?.projects[0]!.result).toBe("failed");
    expect(facts?.projects[0]!.outputCommitted).toBe(true);
    expect(facts?.projects[0]!.written).toBeUndefined();
  });

  test("a late authorization stop keeps the Projects that already committed", () => {
    const stopped = lateAuthorizationStopRecording(
      {
        completedProjects: ["/tmp/first-project"],
        failedProject: { canonicalProject: "/tmp/second-project", project: "/tmp/second-project" },
        pendingProjects: [{ canonicalProject: "/tmp/third-project", project: "/tmp/third-project" }],
      },
      { selection: "project" },
      "Update refuses without explicit changed-file consent (--replace-changed)",
    );
    expect(stopped?.outcome).toBe("partial");
    expect(stopped?.projects.map((project) => project.result)).toEqual([
      "completed",
      "failed",
      "unattempted",
    ]);
    expect(stopped?.projects[0]!.outputCommitted).toBe(true);
    expect(stopped?.projects[0]!.written).toBeUndefined();
    expect(stopped?.failure).toContain("--replace-changed");

    // A stop that committed nothing is a refusal that records nothing.
    expect(lateAuthorizationStopRecording(
      { completedProjects: [] },
      { selection: "project" },
      "Update stopped before writes",
    )).toBeUndefined();
  });

  test("committed output without enumerated paths still renders under Committed", async () => {
    const home = await setupHome();
    await appendOperationHistory(home, {
      command: "update",
      startedAt: "2026-09-10T10:00:00.000Z",
      finishedAt: "2026-09-10T10:00:01.000Z",
      outcome: "partial",
      scope: { selection: "all" },
      projects: [{
        project: "/tmp/first-project",
        canonicalProject: "/tmp/first-project",
        result: "completed",
        outputCommitted: true,
      }],
      failure: "Update refuses without explicit changed-file consent (--replace-changed)",
    });

    const rendered = await readDetails(home, []);
    expect(rendered.exitCode).toBe(0);
    expect(humanText(rendered.output)).toContain("Committed:");
    expect(humanText(rendered.output)).toContain("committed generated output (paths not enumerated)");
  });

  test("invalid invocations and fail-closed refusals record nothing and decide explicitly", async () => {
    const home = await setupHome();
    const projectPath = projectDirectory();
    const refusals = [
      // Missing non-interactive confirmation, an argument error, and a
      // missing Profile choice are refusals before any attempt.
      await invokeInstall(home, ["coding", projectPath, "--host", "codex"]),
      await invokeInstall(home, ["coding", projectPath, "--host", "codex", "--auto-confirm", "--bogus"]),
      await invokeInstall(home, [projectPath, "--host", "codex", "--auto-confirm"]),
      // A zero-match uninstall never attempts removal.
      await invokeUninstall(home, ["--profile", "nosuch", "--all", "--auto-confirm"]),
    ];
    for (const refusal of refusals) {
      expect((await refusal.outcome).exitCode).toBe(1);
      // A refusal is an explicit decision, never an undecided internal error.
      expect(humanText(refusal.streams.errorText())).not.toContain(
        "recorded no operation-history decision",
      );
    }
    expect(existsSync(operationHistoryPath(home))).toBe(false);

    // Missing non-interactive changed-file consent refuses before any write.
    expect((await invokeInstall(home, ["coding", projectPath, "--host", "codex", "--auto-confirm"]).outcome).exitCode).toBe(0);
    writeFileSync(join(projectPath, ".codex", "hooks.json"), "{}\n");
    const before = historyBytes(home);
    const withheld = invokeUpdate(home, ["--all"]);
    expect((await withheld.outcome).exitCode).toBe(1);
    expect(humanText(withheld.streams.errorText())).not.toContain(
      "recorded no operation-history decision",
    );
    expect(historyBytes(home)).toBe(before);
  });

  test("every invocation must decide: a refusal is explicit and an undecided run is reported", async () => {
    const home = await setupHome();

    const refusedStreams = capturedStreams();
    const refused = beginLifecycleOperationRecording();
    refused.recordNothing("a test refusal");
    expect(await finishLifecycleOperationRecording({
      recording: refused,
      home,
      command: "update",
      startedAt: Date.now(),
      finishedAt: Date.now(),
      stderr: refusedStreams.stderr,
    })).toBe("refused");
    expect(refusedStreams.errorText()).toBe("");
    expect(existsSync(operationHistoryPath(home))).toBe(false);

    const undecidedStreams = capturedStreams();
    expect(await finishLifecycleOperationRecording({
      recording: beginLifecycleOperationRecording(),
      home,
      command: "update",
      startedAt: Date.now(),
      finishedAt: Date.now(),
      stderr: undecidedStreams.stderr,
    })).toBe("unrecorded");
    expect(humanText(undecidedStreams.errorText())).toContain(
      "recorded no operation-history decision",
    );
    expect(humanText(undecidedStreams.errorText())).toContain("this run itself is unaffected");
    expect(existsSync(operationHistoryPath(home))).toBe(false);
  });

  test("an interactive batch stopped after committed removals keeps that partial evidence", async () => {
    const home = await setupHome();
    const parent = projectDirectory("agent-profile-kit-details-batch-");
    const first = join(parent, "a-first");
    const second = join(parent, "b-second");
    mkdirSync(first);
    mkdirSync(second);
    for (const project of [first, second]) {
      expect((await invokeInstall(home, ["coding", project, "--host", "codex", "--auto-confirm"]).outcome).exitCode).toBe(0);
    }
    // The second pick carries an independently changed deletion: its consent
    // prompt is the pause point after the first pick already committed.
    writeFileSync(join(second, ".codex", "hooks.json"), "{}\n");

    const input = fakeInteractiveInput();
    const uninstall = invokeUninstall(home, [], input, true);
    const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 50));
    await waitForOutput(uninstall.streams.humanText, "Which Projects");
    input.write(" ");
    await settle();
    input.write("\u001b[B");
    await settle();
    input.write(" ");
    await settle();
    input.write("\r");
    await waitForOutput(uninstall.streams.humanText, "Whole installations or selected Hosts?");
    input.write("\r");
    await waitForOutput(uninstall.streams.humanText, "Uninstall as listed?");
    input.write("y\n");
    await waitForOutput(uninstall.streams.humanText, "Replace or delete these generated files");
    // The reviewed bytes move while the consent prompt waits: the fresh check
    // stops the batch after the first pick committed (US-020).
    writeFileSync(join(second, ".codex", "hooks.json"), "{ }\n");
    input.write("y\n");
    expect((await uninstall.outcome).exitCode).toBe(1);

    const latest = (await detailsEntries(home))[0]!;
    expect(latest.command).toBe("uninstall");
    expect(latest.outcome).toBe("partial");
    expect(latest.failure).toBeDefined();
    expect(latest.projects.some((project) => project.result === "completed")).toBe(true);
    expect(latest.projects.some((project) => project.result === "unattempted")).toBe(true);
    // The committed removal stays removed; the stopped pick stays untouched.
    expect(existsSync(join(first, ".codex", "hooks.json"))).toBe(false);
    expect(existsSync(join(second, ".codex", "hooks.json"))).toBe(true);
  });

  test("a blocked install records its blocker evidence without committed work", async () => {
    const home = await setupHome();
    const projectPath = projectDirectory();
    mkdirSync(join(projectPath, ".codex"), { recursive: true });
    writeFileSync(join(projectPath, ".codex", "hooks.json"), "{}\n");

    const install = invokeInstall(home, ["coding", projectPath, "--host", "codex", "--auto-confirm"]);
    expect((await install.outcome).exitCode).toBe(2);

    const entry = (await detailsEntries(home))[0]!;
    expect(entry.command).toBe("install");
    expect(entry.outcome).toBe("blocked");
    expect(entry.projects[0]!.result).toBe("skipped");
    expect(entry.projects[0]!.failure).toContain("occupied-output");
    expect(entry.projects[0]!.written).toBeUndefined();
    expect(readFileSync(join(projectPath, ".codex", "hooks.json"), "utf8")).toBe("{}\n");
  });

  test("a stopped uninstall records failed and remaining work", async () => {
    const home = await setupHome();
    const projectPath = projectDirectory();
    expect((await invokeInstall(home, ["coding", projectPath, "--host", "codex", "--auto-confirm"]).outcome).exitCode).toBe(0);
    // A read-only Project root makes the proven removal fail mid-transaction.
    chmodSync(projectPath, 0o500);
    try {
      const uninstall = invokeUninstall(home, ["--all", "--auto-confirm"]);
      expect((await uninstall.outcome).exitCode).toBe(1);
    } finally {
      chmodSync(projectPath, 0o700);
    }

    const latest = (await detailsEntries(home))[0]!;
    expect(latest.command).toBe("uninstall");
    expect(latest.outcome).toBe("failed");
    expect(latest.failure).toBeDefined();
    expect(latest.projects[0]!.result).toBe("failed");
    expect(latest.projects[0]!.restored).toBe(true);
  });

  test("a partial uninstall records completed work beside the failure", async () => {
    const home = await setupHome();
    const parent = projectDirectory("agent-profile-kit-details-fleet-");
    const healthy = join(parent, "a-healthy");
    const failing = join(parent, "z-readonly");
    mkdirSync(healthy);
    mkdirSync(failing);
    for (const project of [healthy, failing]) {
      expect((await invokeInstall(home, ["coding", project, "--host", "codex", "--auto-confirm"]).outcome).exitCode).toBe(0);
    }
    chmodSync(failing, 0o500);
    try {
      expect((await invokeUninstall(home, ["--all", "--auto-confirm"]).outcome).exitCode).toBe(1);
    } finally {
      chmodSync(failing, 0o700);
    }

    const latest = (await detailsEntries(home))[0]!;
    expect(latest.outcome).toBe("partial");
    const completed = latest.projects.find((project) => project.result === "completed")!;
    const failed = latest.projects.find((project) => project.result === "failed")!;
    expect(completed.canonicalProject).toContain("a-healthy");
    expect(completed.removed).toContain(".codex/hooks.json");
    expect(failed.canonicalProject).toContain("z-readonly");
  });

  test("read-only commands leave history byte-identical", async () => {
    const home = await setupHome();
    const projectPath = projectDirectory();
    expect((await invokeInstall(home, ["coding", projectPath, "--host", "codex", "--auto-confirm"]).outcome).exitCode).toBe(0);
    const before = historyBytes(home);

    await statusApplication(home);
    for (const arguments_ of [[], ["--list"], ["op-000001"], ["--json"]]) {
      await readDetails(home, arguments_);
    }
    await readDetails(home, ["op-999999"]);
    expect(historyBytes(home)).toBe(before);
  });

  test("no recorded history and an evicted identity have clear outcomes", async () => {
    const home = await setupHome();
    const empty = await readDetails(home, []);
    expect(empty.exitCode).toBe(0);
    expect(humanText(empty.output)).toContain("No lifecycle operations are recorded yet");

    const emptyList = await readDetails(home, ["--list"]);
    expect(emptyList.exitCode).toBe(0);
    expect(humanText(emptyList.output)).toContain("No lifecycle operations are recorded yet");

    const emptyJson = JSON.parse((await readDetails(home, ["--json"])).output) as { outcome: string };
    expect(emptyJson.outcome).toBe("empty");
    expect(existsSync(operationHistoryPath(home))).toBe(false);

    const missing = await readDetails(home, ["op-000042"]);
    expect(missing.exitCode).toBe(1);
    expect(humanText(missing.error)).toContain("no recorded operation has the identity 'op-000042'");
    const missingJson = JSON.parse((await readDetails(home, ["op-000042", "--json"])).output) as {
      outcome: string;
      error: string;
    };
    expect(missingJson.outcome).toBe("error");
    expect(missingJson.error).toContain("op-000042");
  });

  test("keeps exactly the latest 200 runs through the public command and evicts the oldest", async () => {
    const home = await setupHome();
    for (let index = 1; index <= 201; index += 1) {
      expect((await invokeUpdate(home, ["--all"]).outcome).exitCode).toBe(0);
    }

    const entries = await detailsEntries(home);
    expect(entries).toHaveLength(200);
    expect(entries[0]!.id).toBe("op-000201");
    expect(entries.at(-1)!.id).toBe("op-000002");
    expect(entries.map((entry) => entry.id)).not.toContain("op-000001");

    const evicted = await readDetails(home, ["op-000001"]);
    expect(evicted.exitCode).toBe(1);
    expect(humanText(evicted.error)).toContain("op-000001");
    const retained = await readDetails(home, ["op-000002"]);
    expect(retained.exitCode).toBe(0);
  });

  test("concurrent recording retains every report", async () => {
    const home = await setupHome();
    const [first, second] = await Promise.all([
      invokeUpdate(home, ["--all"]).outcome,
      invokeUpdate(home, ["--all"]).outcome,
    ]);
    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);

    const entries = await detailsEntries(home);
    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.id)).toEqual(["op-000002", "op-000001"]);
  });

  test("a recording failure warns with complete evidence and keeps the run committed", async () => {
    const home = await setupHome();
    const projectPath = projectDirectory();
    // The history destination is not a file: publication must fail closed.
    mkdirSync(operationHistoryPath(home), { recursive: true });

    const install = invokeInstall(home, ["coding", projectPath, "--host", "codex", "--auto-confirm"]);
    expect((await install.outcome).exitCode).toBe(0);

    const output = humanText(install.streams.humanText());
    const error = humanText(install.streams.errorText());
    expect(output).toContain("Installed coding");
    expect(error).toContain("operation history could not be saved");
    // The complete run evidence is displayed, not lost with the entry.
    expect(error).toContain("Install (not saved)");
    expect(error).toContain("Committed:");
    expect(error).toContain(".agent-profile-kit/codex/context.md");
    expect(error).toContain(".codex/hooks.json");
    expect(error).toContain("Outcome: succeeded");
    // Successful lifecycle work is never rolled back.
    expect(existsSync(join(projectPath, ".codex", "hooks.json"))).toBe(true);
    expect(readFileSync(configPath(home), "utf8")).toContain("profile: coding");

    const details = await readDetails(home, []);
    expect(details.exitCode).toBe(1);
    expect(humanText(details.error)).toContain("operation history could not be read");
  });

  test("machine JSON reports the details family for latest, list, and one identity", async () => {
    const home = await setupHome();
    const projectPath = projectDirectory();
    expect((await invokeInstall(home, ["coding", projectPath, "--host", "codex", "--auto-confirm"]).outcome).exitCode).toBe(0);

    for (const [arguments_, selection] of [
      [["--json"], "latest"],
      [["--list", "--json"], "list"],
      [["op-000001", "--json"], "id"],
    ] as const) {
      const payload = JSON.parse((await readDetails(home, [...arguments_])).output) as {
        schemaVersion: number;
        command: string;
        outcome: string;
        selection: string;
        history: string;
        entries: readonly OperationHistoryEntry[];
      };
      expect(payload.schemaVersion).toBe(1);
      expect(payload.command).toBe("details");
      expect(payload.outcome).toBe("clean");
      expect(payload.selection).toBe(selection);
      expect(payload.history).toBe(operationHistoryPath(home));
      expect(payload.entries).toHaveLength(1);
      expect(payload.entries[0]!.id).toBe("op-000001");
    }
  });

  test("details rejects invalid arguments without touching history", async () => {
    const home = await setupHome();
    expect((await readDetails(home, ["--unknown"])).exitCode).toBe(1);
    expect((await readDetails(home, ["--list", "op-000001"])).exitCode).toBe(1);
    expect((await readDetails(home, ["op-000001", "op-000002"])).exitCode).toBe(1);
    expect(existsSync(operationHistoryPath(home))).toBe(false);
  });

  test("a long interactive detail pages through the shared pager and redirected output never does", async () => {
    const home = await setupHome();
    const projectPath = projectDirectory();
    expect((await invokeInstall(home, ["coding", projectPath, "--host", "codex", "--auto-confirm"]).outcome).exitCode).toBe(0);
    const calls: string[] = [];
    const pagerExecution: InteractiveExecution = async (options) => {
      calls.push(options.stdin);
      return {
        kind: "exit",
        exitCode: 0,
        signal: null,
        error: null,
        cleanupFailed: false,
        durationMs: 1,
        commandLabel: "pager test",
      };
    };

    // Redirected (non-interactive) output is delivered in full, never paged.
    const redirected = await readDetails(home, [], { pagerExecution });
    expect(redirected.exitCode).toBe(0);
    expect(calls).toEqual([]);
    expect(humanText(redirected.output)).toContain("op-000001");

    // An interactive terminal whose height is one line pages the same document.
    const interactiveStreams = capturedStreams(true);
    (interactiveStreams.output as PassThrough & { rows?: number }).rows = 1;
    const outcome = await runDetailsCommand({
      home,
      arguments: [],
      stdout: interactiveStreams.output,
      stderr: interactiveStreams.stderr,
      pagerExecution,
      pagerEnvironment: { PAGER: "less" },
    });
    expect(outcome.exitCode).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("Install op-000001");
    expect(calls[0]).toContain(".codex/hooks.json");
  });

  test("the retained document is strict JSON that the production reader accepts", async () => {
    const home = await setupHome();
    const projectPath = projectDirectory();
    expect((await invokeInstall(home, ["coding", projectPath, "--host", "codex", "--auto-confirm"]).outcome).exitCode).toBe(0);
    const history = await readOperationHistory(home);
    expect(JSON.parse(historyBytes(home))).toEqual(history);
  });
});
