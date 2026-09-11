import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";

import { runApplyCommand, fullySpecifiedApplyArguments } from "../cli/apply-command.js";
import { humanText } from "./support/human-text.js";
import { retireBindingByHand } from "./support/retire-receipt.js";
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
    removeChanged: arguments_.includes("--remove-changed"),
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
    command: "update" as const,
    match: "exact" as const,
    target: scopeArgument,
    ...(filter === undefined ? {} : { filter }),
  };
}

describe("update replacement confirmation command", () => {
  test("interactive fully specified update names the changed files and accepts a yes answer", async () => {
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
    expect(output).toContain("Updated:");
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
    expect(stdout).not.toContain("Updated:");
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
    expect(stdout).toContain("Updated:");
    expect(readFileSync(fleet.driftedOutputPath, "utf8")).toContain("Confirmation fixture.");
  });

  test("non-interactive update without consent refuses before any write with a runnable remedy", async () => {
    const fleet = await prepareDriftedFleet("agent-profile-kit-cmd-noninteractive");
    // A plain pipe carries no TTY evidence; the invocation must not wait on it.
    const invocation = invoke(fleet, [fleet.driftedProject], undefined, { interactive: false });
    const { exitCode } = await invocation.outcome;
    expect(exitCode).toBe(1);
    const stdout = humanText(invocation.stdout.text());
    expect(stdout).not.toContain("(y/N)");
    expect(stdout).not.toContain("Updated:");
    const stderr = humanText(invocation.stderr.text());
    expect(stderr).toContain("--replace-changed");
    expect(readFileSync(fleet.driftedOutputPath, "utf8")).toBe(fleet.driftedBytes);
    expect(existsSync(join(fleet.healthyProject, ".agent-profile-kit"))).toBe(false);
  });

  test("non-interactive update with --replace-changed completes without a prompt", async () => {
    const fleet = await prepareDriftedFleet("agent-profile-kit-cmd-noninteractive-flag");
    const invocation = invoke(
      fleet,
      [fleet.driftedProject, "--replace-changed"],
      undefined,
      { interactive: false },
    );
    const { exitCode } = await invocation.outcome;
    expect(exitCode).toBe(0);
    const stdout = humanText(invocation.stdout.text());
    expect(stdout).not.toContain("(y/N)");
    expect(stdout).toContain("Updated:");
    expect(readFileSync(fleet.driftedOutputPath, "utf8")).toContain("Confirmation fixture.");
  });

  test("JSON output without consent refuses instead of prompting", async () => {
    const fleet = await prepareDriftedFleet("agent-profile-kit-cmd-json");
    const invocation = invoke(fleet, [fleet.driftedProject, "--json"], (input) => {
      // An answer arriving proves a prompt fired; the payload must not wait.
      setTimeout(() => input.write("n\n"), 5);
    });
    const { exitCode } = await invocation.outcome;
    expect(exitCode).toBe(1);
    expect(readFileSync(fleet.driftedOutputPath, "utf8")).toBe(fleet.driftedBytes);
  });

  test("JSON output with --replace-changed never prompts and retains the replacement receipt", async () => {
    const fleet = await prepareDriftedFleet("agent-profile-kit-cmd-json-flag");
    const invocation = invoke(fleet, [fleet.driftedProject, "--json", "--replace-changed"], (input) => {
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
    await retireBindingByHand(fleet.home, fleet.healthyProject);
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

  test("viewing the optional diff grants no consent and returns to the same scope", async () => {
    const fleet = await prepareDriftedFleet("agent-profile-kit-cmd-diff");
    const stdout = new RecordingSink();
    const stderr = new RecordingSink();
    const input = fakeInteractiveInput();
    const outcome = runApplyCommand({
      home: fleet.home,
      selection: parsedSelection([fleet.driftedProject], fleet),
      json: false,
      replaceChanged: false,
      removeChanged: false,
      verbose: false,
      stdout,
      stderr,
      input,
    });
    let step: "diff" | "accept" | "done" = "diff";
    const poll = setInterval(() => {
      const text = humanText(stdout.text());
      if (!text.includes("(y/N)")) return;
      if (step === "diff") {
        step = "accept";
        input.write("d\n");
      } else if (step === "accept" && text.includes("current/")) {
        step = "done";
        clearInterval(poll);
        input.write("y\n");
      }
    }, 1);
    const { exitCode } = await outcome;
    clearInterval(poll);
    expect(exitCode).toBe(0);
    const rendered = humanText(stdout.text());
    // The diff compares actual disk bytes against the planned replacement.
    expect(rendered).toContain("current/");
    expect(rendered).toContain("hand-edited");
    expect(readFileSync(fleet.driftedOutputPath, "utf8")).toContain("Confirmation fixture.");
  });

  test("repeated diff views page through the remaining hunks", async () => {
    const fleet = await prepareDriftedFleet("agent-profile-kit-cmd-diff-pages");
    writeFileSync(
      fleet.driftedOutputPath,
      Array.from({ length: 70 }, (_, index) => `user line ${index}`).join("\n") + "\n",
    );
    const stdout = new RecordingSink();
    const stderr = new RecordingSink();
    const input = fakeInteractiveInput();
    const outcome = runApplyCommand({
      home: fleet.home,
      selection: parsedSelection([fleet.driftedProject], fleet),
      json: false,
      replaceChanged: false,
      removeChanged: false,
      verbose: false,
      stdout,
      stderr,
      input,
    });
    let step: "first" | "second" | "done" = "first";
    const poll = setInterval(() => {
      const text = humanText(stdout.text());
      if (step === "first" && text.includes("(y/N)")) {
        step = "second";
        input.write("d\n");
      } else if (step === "second" && text.includes("page 1/")) {
        step = "done";
        clearInterval(poll);
        input.write("d\n");
        setTimeout(() => input.write("y\n"), 50);
      }
    }, 1);
    const { exitCode } = await outcome;
    clearInterval(poll);
    expect(exitCode).toBe(0);
    const rendered = humanText(stdout.text());
    expect(rendered).toContain("more changes remain (page 1/");
    expect(rendered).toContain("last page");
    expect(readFileSync(fleet.driftedOutputPath, "utf8")).toContain("Confirmation fixture.");
  });

  test("a late refusal reports committed work instead of claiming no writes", async () => {
    const fleet = await prepareDriftedFleet("agent-profile-kit-cmd-late");
    const seed = invoke(fleet, ["--all", "--replace-changed"], undefined, { interactive: false });
    expect((await seed.outcome).exitCode).toBe(0);
    writeFileSync(
      join(fleet.workspace, "context", "team-rules.md"),
      "---\nid: team-rules\ndependencies: []\n---\nUpdated shared.\n",
    );
    writeFileSync(fleet.driftedOutputPath, fleet.driftedBytes);
    const healthyOutput = join(fleet.healthyProject, ".agent-profile-kit", "codex", "context.md");
    const stdout = new RecordingSink();
    const stderr = new RecordingSink();
    const input = fakeInteractiveInput();
    const outcome = runApplyCommand({
      home: fleet.home,
      selection: parsedSelection(["--all"], fleet),
      json: false,
      replaceChanged: false,
      removeChanged: false,
      verbose: false,
      stdout,
      stderr,
      input,
    });
    let answered = false;
    const poll = setInterval(() => {
      if (!humanText(stdout.text()).includes("(y/N)")) return;
      if (answered) return;
      answered = true;
      clearInterval(poll);
      writeFileSync(healthyOutput, "concurrent edit\n");
      input.write("y\n");
    }, 1);
    const { exitCode } = await outcome;
    clearInterval(poll);
    expect(exitCode).toBe(1);
    const rendered = humanText(stderr.text());
    // The first Project's committed work is reported; the no-write claim
    // that belongs to the invocation-wide refusal must not appear.
    expect(rendered).toContain(fleet.driftedProject);
    expect(rendered).not.toContain("No Project or setting was changed");
    expect(readFileSync(fleet.driftedOutputPath, "utf8")).toContain("Updated shared.");
    expect(readFileSync(healthyOutput, "utf8")).toBe("concurrent edit\n");
  });

  test("leaving the diff without accepting leaves the whole invocation untouched", async () => {
    const fleet = await prepareDriftedFleet("agent-profile-kit-cmd-diff-leave");
    const stdout = new RecordingSink();
    const stderr = new RecordingSink();
    const input = fakeInteractiveInput();
    const outcome = runApplyCommand({
      home: fleet.home,
      selection: parsedSelection([fleet.driftedProject], fleet),
      json: false,
      replaceChanged: false,
      removeChanged: false,
      verbose: false,
      stdout,
      stderr,
      input,
    });
    let step: "diff" | "decline" | "done" = "diff";
    const poll = setInterval(() => {
      const text = humanText(stdout.text());
      if (!text.includes("(y/N)")) return;
      if (step === "diff") {
        step = "decline";
        input.write("d\n");
      } else if (step === "decline" && text.includes("current/")) {
        step = "done";
        clearInterval(poll);
        input.write("n\n");
      }
    }, 1);
    const { exitCode } = await outcome;
    clearInterval(poll);
    expect(exitCode).toBe(1);
    expect(readFileSync(fleet.driftedOutputPath, "utf8")).toBe(fleet.driftedBytes);
    expect(existsSync(join(fleet.healthyProject, ".agent-profile-kit"))).toBe(false);
  });

  test("the default empty answer declines and says so", async () => {
    const fleet = await prepareDriftedFleet("agent-profile-kit-cmd-default-says");
    const invocation = invoke(
      fleet,
      [fleet.driftedProject],
      (input) => input.write("\n"),
      { feedAfterQuestion: true },
    );
    const { exitCode } = await invocation.outcome;
    expect(exitCode).toBe(1);
    const stderr = humanText(invocation.stderr.text());
    expect(stderr).toContain("nothing was written");
    expect(stderr).toContain("default");
  });

  test("--remove-changed does not authorize replacement at the command seam", async () => {
    const fleet = await prepareDriftedFleet("agent-profile-kit-cmd-no-cross");
    const invocation = invoke(
      fleet,
      [fleet.driftedProject, "--remove-changed"],
      undefined,
      { interactive: false },
    );
    const { exitCode } = await invocation.outcome;
    expect(exitCode).toBe(1);
    const stderr = humanText(invocation.stderr.text());
    // The missing replacement flag is named, and the already-supplied
    // deletion flag is kept so the remedy stays runnable.
    expect(stderr).toContain("--replace-changed");
    expect(stderr).toContain("--remove-changed");
    expect(readFileSync(fleet.driftedOutputPath, "utf8")).toBe(fleet.driftedBytes);
  });

  test("a mixed-scope refusal remedy keeps already-supplied flags", async () => {
    const fleet = await prepareDriftedFleet("agent-profile-kit-cmd-mixed");
    const seed = invoke(fleet, ["--all", "--replace-changed", "--remove-changed"], undefined, {
      interactive: false,
    });
    expect((await seed.outcome).exitCode).toBe(0);
    // One invocation holds an authorized replacement (bound, drifted) plus an
    // unauthorized deletion (unbound with drifted surviving output).
    writeFileSync(fleet.driftedOutputPath, fleet.driftedBytes);
    const healthyOutput = join(fleet.healthyProject, ".agent-profile-kit", "codex", "context.md");
    writeFileSync(healthyOutput, "healthy drift\n");
    writeFileSync(
      fleet.configPath,
      `schema_version: 2\nworkspace: ${fleet.workspace}\nbindings:\n` +
        `  - project: ${fleet.driftedProject}\n    profile: coding\n    hosts: [codex]\n`,
    );
    const invocation = invoke(
      fleet,
      ["--all", "--replace-changed"],
      undefined,
      { interactive: false },
    );
    const { exitCode } = await invocation.outcome;
    expect(exitCode).toBe(1);
    const stderr = humanText(invocation.stderr.text());
    // The remedy stays runnable: it keeps the supplied replacement flag and
    // adds the missing deletion flag.
    expect(stderr).toContain("--replace-changed");
    expect(stderr).toContain("--remove-changed");
    expect(readFileSync(fleet.driftedOutputPath, "utf8")).toBe(fleet.driftedBytes);
    expect(readFileSync(healthyOutput, "utf8")).toBe("healthy drift\n");
  });

  test("the equivalent command expresses every scope argument explicitly", () => {
    expect(fullySpecifiedApplyArguments({
      kind: "all",
    })).toEqual(["update", "--all", "--replace-changed"]);
    expect(fullySpecifiedApplyArguments({
      kind: "project",
      command: "update",
      match: "containing",
      target: "/tmp/project",
      filter: "stale",
    })).toEqual(["update", "--here", "--stale", "--replace-changed"]);
    expect(fullySpecifiedApplyArguments({
      kind: "project",
      command: "update",
      match: "exact",
      target: "/tmp/project",
    })).toEqual(["update", "/tmp/project", "--replace-changed"]);
    expect(fullySpecifiedApplyArguments({ kind: "all" }, { replace: true, remove: true }))
      .toEqual(["update", "--all", "--replace-changed", "--remove-changed"]);
    expect(fullySpecifiedApplyArguments({ kind: "all" }, { replace: false, remove: true }))
      .toEqual(["update", "--all", "--remove-changed"]);
  });
});
