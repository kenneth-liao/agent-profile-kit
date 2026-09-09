import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";

import { runApplyCommand, fullySpecifiedApplyArguments } from "../cli/apply-command.js";
import { humanText } from "./support/human-text.js";
import {
  cleanupTemporaryDirectories,
  prepareDriftedFleet,
  type DriftedFleetFixture,
} from "./support/apply-confirmation-fixture.js";

afterAll(cleanupTemporaryDirectories);

/** A fake interactive input stream: the prompt seam reads TTY evidence from it. */
function fakeInteractiveInput(): PassThrough & { isTTY: true } {
  const stream = new PassThrough() as PassThrough & { isTTY: true };
  stream.isTTY = true;
  return stream;
}

interface Invocation {
  readonly outcome: Promise<{ readonly exitCode: 0 | 1 | 2 }>;
  readonly stdout: RecordingSink;
  readonly stderr: RecordingSink;
}

/** A writable sink that records every chunk without consuming them. */
class RecordingSink extends Writable {
  readonly chunks: Buffer[] = [];

  override _write(chunk: Buffer, _encoding: string, callback: () => void): void {
    this.chunks.push(chunk);
    callback();
  }

  text(): string {
    return Buffer.concat(this.chunks).toString();
  }
}

function invoke(
  fleet: DriftedFleetFixture,
  arguments_: readonly string[],
  feed?: (input: PassThrough) => void,
  { interactive = true, feedAfterQuestion = false }: {
    readonly interactive?: boolean;
    readonly feedAfterQuestion?: boolean;
  } = {},
): Invocation {
  const stdout = new RecordingSink();
  const stderr = new RecordingSink();
  const input = interactive ? fakeInteractiveInput() : new PassThrough();
  // The apply command owns parsing; tests pass the normalized selection the
  // packed CLI parser would produce for these arguments.
  const selection = parsedSelection(arguments_, fleet);
  const outcome = runApplyCommand({
    home: fleet.home,
    selection,
    json: arguments_.includes("--json"),
    replaceChanged: arguments_.includes("--replace-changed"),
    verbose: false,
    stdout,
    stderr,
    input,
  });
  feed?.(input);
  if (feedAfterQuestion && feed !== undefined) {
    // Poll the recorded output: the question stays pending until answered.
    const poll = setInterval(() => {
      if (stdout.text().includes("(y/N)")) {
        clearInterval(poll);
        feed(input);
      }
    }, 1);
  }
  return { outcome, stdout, stderr };
}

/** Mirrors the packed CLI's scope parsing for the fixture's two-Project fleet. */
function parsedSelection(arguments_: readonly string[], fleet: DriftedFleetFixture) {
  const scopeArgument = arguments_.find((argument) => !argument.startsWith("-"));
  const filter = arguments_.includes("--stale")
    ? "stale" as const
    : arguments_.includes("--blocked")
    ? "blocked" as const
    : undefined;
  if (scopeArgument === undefined) {
    return filter === undefined ? { kind: "all" as const } : { kind: "all" as const, filter };
  }
  return {
    kind: "project" as const,
    command: "apply" as const,
    match: "exact" as const,
    target: scopeArgument,
    ...(filter === undefined ? {} : { filter }),
  };
}

describe("apply replacement confirmation command", () => {
  test("interactive fully specified apply names the changed files and accepts a yes answer", async () => {
    const fleet = await prepareDriftedFleet("agent-profile-kit-cmd-accept");
    const invocation = invoke(
      fleet,
      [fleet.driftedProject],
      (input) => input.write("y\n"),
      { feedAfterQuestion: true },
    );
    const { exitCode } = await invocation.outcome;
    expect(exitCode).toBe(0);
    const output = humanText(invocation.stdout.text());
    // The confirmation names the affected changed file before any write.
    expect(output).toContain("Changed generated files:");
    expect(output).toContain(".agent-profile-kit/codex/context.md");
    expect(output).toContain("(y/N)");
    // The committed receipt names the replacement.
    expect(output).toContain("Applied:");
    expect(output).toContain(".agent-profile-kit/codex/context.md");
    // The completed flow prints the equivalent fully specified command.
    expect(output).toContain("--replace-changed");
    expect(output).toContain(fleet.driftedProject);
    expect(readFileSync(fleet.driftedOutputPath, "utf8")).toContain("Confirmation fixture.");
  });

  test("a declined answer aborts the whole invocation with zero writes", async () => {
    const fleet = await prepareDriftedFleet("agent-profile-kit-cmd-decline");
    const invocation = invoke(
      fleet,
      [fleet.driftedProject],
      (input) => input.write("n\n"),
      { feedAfterQuestion: true },
    );
    const { exitCode } = await invocation.outcome;
    expect(exitCode).toBe(1);
    const stdout = humanText(invocation.stdout.text());
    const stderr = humanText(invocation.stderr.text());
    expect(stdout).toContain("Changed generated files:");
    expect(stdout).not.toContain("Applied:");
    // The happened/why/what-to-type diagnostic names the explicit command.
    expect(stderr).toContain("nothing was written");
    expect(stderr).toContain("--replace-changed");
    // No configuration or generated-output write anywhere.
    expect(readFileSync(fleet.driftedOutputPath, "utf8")).toBe(fleet.driftedBytes);
    expect(existsSync(join(fleet.healthyProject, ".agent-profile-kit"))).toBe(false);
  });

  test("the default empty answer declines", async () => {
    const fleet = await prepareDriftedFleet("agent-profile-kit-cmd-default");
    const invocation = invoke(
      fleet,
      [fleet.driftedProject],
      (input) => input.write("\n"),
      { feedAfterQuestion: true },
    );
    const { exitCode } = await invocation.outcome;
    expect(exitCode).toBe(1);
    expect(readFileSync(fleet.driftedOutputPath, "utf8")).toBe(fleet.driftedBytes);
    expect(existsSync(join(fleet.healthyProject, ".agent-profile-kit"))).toBe(false);
  });

  test("cancellation after the question aborts with zero writes", async () => {
    const fleet = await prepareDriftedFleet("agent-profile-kit-cmd-cancel");
    const invocation = invoke(
      fleet,
      [fleet.driftedProject],
      (input) => input.end(),
      { feedAfterQuestion: true },
    );
    const { exitCode } = await invocation.outcome;
    expect(exitCode).toBe(1);
    const stderr = humanText(invocation.stderr.text());
    expect(stderr).toContain("cancelled");
    expect(readFileSync(fleet.driftedOutputPath, "utf8")).toBe(fleet.driftedBytes);
    expect(existsSync(join(fleet.healthyProject, ".agent-profile-kit"))).toBe(false);
  });

  test("cancellation before the question is asked aborts with zero writes", async () => {
    const fleet = await prepareDriftedFleet("agent-profile-kit-cmd-cancel-early");
    const invocation = invoke(fleet, [fleet.driftedProject], (input) => input.end());
    const { exitCode } = await invocation.outcome;
    expect(exitCode).toBe(1);
    const stderr = humanText(invocation.stderr.text());
    expect(stderr).toContain("cancelled");
    expect(readFileSync(fleet.driftedOutputPath, "utf8")).toBe(fleet.driftedBytes);
    expect(existsSync(join(fleet.healthyProject, ".agent-profile-kit"))).toBe(false);
  });

  test("the answering flag permits replacement without a prompt on an interactive stream", async () => {
    const fleet = await prepareDriftedFleet("agent-profile-kit-cmd-flag");
    const invocation = invoke(fleet, [fleet.driftedProject, "--replace-changed"]);
    const { exitCode } = await invocation.outcome;
    expect(exitCode).toBe(0);
    const stdout = humanText(invocation.stdout.text());
    expect(stdout).not.toContain("(y/N)");
    expect(stdout).toContain("Applied:");
    expect(readFileSync(fleet.driftedOutputPath, "utf8")).toContain("Confirmation fixture.");
  });

  test("non-interactive apply never prompts and completes with the replacement receipt", async () => {
    const fleet = await prepareDriftedFleet("agent-profile-kit-cmd-noninteractive");
    // A plain pipe carries no TTY evidence; the invocation must not wait on it.
    const invocation = invoke(fleet, [fleet.driftedProject], undefined, { interactive: false });
    const { exitCode } = await invocation.outcome;
    expect(exitCode).toBe(0);
    const stdout = humanText(invocation.stdout.text());
    expect(stdout).not.toContain("(y/N)");
    expect(stdout).toContain("Applied:");
    expect(readFileSync(fleet.driftedOutputPath, "utf8")).toContain("Confirmation fixture.");
  });

  test("JSON output never prompts and retains the replacement receipt", async () => {
    const fleet = await prepareDriftedFleet("agent-profile-kit-cmd-json");
    const invocation = invoke(fleet, [fleet.driftedProject, "--json"], (input) => {
      // An answer arriving proves a prompt fired; the payload must not wait.
      setTimeout(() => input.write("n\n"), 5);
    });
    const { exitCode } = await invocation.outcome;
    expect(exitCode).toBe(0);
    const payload = JSON.parse(invocation.stdout.text() || "{}") as {
      readonly applied: { readonly projects: readonly { readonly outputs: readonly {
        readonly path: string;
        readonly driftKind?: string;
      }[] }[] };
    };
    const drifted = payload.applied.projects.find(
      (project) => project.outputs.some((output) => output.path.endsWith("context.md")),
    );
    expect(drifted).toBeDefined();
    expect(readFileSync(fleet.driftedOutputPath, "utf8")).toContain("Confirmation fixture.");
  });

  test("the answering flag cannot bypass a Blocker", async () => {
    const fleet = await prepareDriftedFleet("agent-profile-kit-cmd-flag-blocked");
    const { unbindProject } = await import("../installer/unbind-project.js");
    await unbindProject({ home: fleet.home, project: fleet.healthyProject });
    writeFileSync(
      fleet.configPath,
      `schema_version: 2\nworkspace: ${fleet.workspace}\nbindings:\n  - project: ${fleet.driftedProject}\n    profile: coding\n    hosts: [codex, claude]\n`,
    );
    const { execFileSync } = await import("node:child_process");
    execFileSync("git", ["init", "--quiet"], { cwd: fleet.driftedProject });
    mkdirSync(join(fleet.driftedProject, ".claude", "rules"), { recursive: true });
    writeFileSync(join(fleet.driftedProject, ".claude", "rules", "agent-profile-kit.md"), "foreign\n");
    execFileSync("git", ["-C", fleet.driftedProject, "add", ".claude/rules/agent-profile-kit.md"]);
    const invocation = invoke(fleet, [fleet.driftedProject, "--replace-changed"]);
    const { exitCode } = await invocation.outcome;
    expect(exitCode).toBe(2);
    expect(readFileSync(fleet.driftedOutputPath, "utf8")).toBe(fleet.driftedBytes);
  });

  test("the equivalent command expresses every scope argument explicitly", () => {
    expect(fullySpecifiedApplyArguments({
      kind: "all",
    })).toEqual(["apply", "--all", "--replace-changed"]);
    expect(fullySpecifiedApplyArguments({
      kind: "project",
      command: "apply",
      match: "containing",
      target: "/tmp/project",
      filter: "stale",
    })).toEqual(["apply", "--here", "--stale", "--replace-changed"]);
    expect(fullySpecifiedApplyArguments({
      kind: "project",
      command: "apply",
      match: "exact",
      target: "/tmp/project",
    })).toEqual(["apply", "/tmp/project", "--replace-changed"]);
  });
});
