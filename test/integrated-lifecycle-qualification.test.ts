/**
 * Integrated lifecycle qualification (ticket #517, spec #491).
 *
 * One release-candidate journey proving interaction among delivered
 * capabilities; predecessor behavior is relied on, not owned again. Covers:
 * - AC2/DEC-006/DEC-008: a completed operation's details stay available
 *   across later no-op and cancelled attempts, and failed lifecycle recovery
 *   is reported as failed in history and rendered evidence — never as
 *   success.
 * - F2/US-020/TEST-014 interaction: the uninstall path offers the one shared
 *   optional diff view before deleting independently changed generated
 *   output (install and update consumption is pinned by their own suites).
 * - F2/US-021/TEST-013 interaction: a real install writes the
 *   generated-source notice into Skill, Context, and Host-configuration
 *   output (projector unit contracts stay owned by their own suite).
 *
 * Sibling contracts are dependencies, not duplicate acceptance ownership.
 * TEST-010/TEST-011 human qualification is prepared elsewhere; nothing here
 * substitutes agent approval for human acceptance (DEC-013).
 */
import { describe, expect, test } from "bun:test";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, type Writable } from "node:stream";
import { parse as parseYaml } from "yaml";

import { runApplyCommand } from "../cli/apply-command.js";
import { runConfigureCommand } from "../cli/configure-command.js";
import { runDetailsCommand } from "../cli/details-command.js";
import { runInstallCommand } from "../cli/install-command.js";
import { uninstallExecutionFailureDocument } from "../cli/presentation.js";
import { writeHumanDocument } from "../cli/presentation-document.js";
import { terminalPresentationContext } from "../cli/terminal-presentation.js";
import {
  beginLifecycleOperationRecording,
  finishLifecycleOperationRecording,
  uninstallRecording,
} from "../cli/operation-recording.js";
import { runUninstallCommand } from "../cli/uninstall-command.js";
import { initializeWorkspace } from "../installer/initialize-workspace.js";
import { executeInstall } from "../installer/install-application.js";
import { readInstallationState, writeInstallationState } from "../installer/installation-state.js";
import { defaultFileSystem } from "../installer/local-configuration-publication.js";
import { executeUninstall } from "../installer/uninstall-application.js";
import type { OperationHistoryEntry } from "../installer/operation-history.js";
import type { ProjectBindingSelection } from "../installer/local-configuration.js";
import { humanText } from "./support/human-text.js";
import { parseGeneratedJsonc } from "./support/generated-notice.js";

function isolatedHome(): string {
  return mkdtempSync(join(tmpdir(), "agent-profile-kit-517-"));
}

function projectDirectory(): string {
  return mkdtempSync(join(tmpdir(), "agent-profile-kit-517-project-"));
}

function workspacePath(home: string): string {
  return join(home, "apkit-workspace");
}

function configPath(home: string): string {
  return join(home, ".agents", "agent-profile-kit", "config.yaml");
}

async function setupHome(): Promise<string> {
  const home = isolatedHome();
  await initializeWorkspace(home, { workspace: "~/apkit-workspace" });
  mkdirSync(join(workspacePath(home), "context"), { recursive: true });
  writeFileSync(
    join(workspacePath(home), "context", "team-rules.md"),
    "Always preserve the project boundary.\n",
  );
  for (const skill of ["review-pr", "deploy"]) {
    mkdirSync(join(workspacePath(home), "skills", skill), { recursive: true });
    writeFileSync(
      join(workspacePath(home), "skills", skill, "SKILL.md"),
      `---\nname: ${skill}\ndescription: Skill ${skill}.\n---\n\n# ${skill}\n\nPreserved body bytes.\n`,
    );
  }
  mkdirSync(join(workspacePath(home), "profiles"), { recursive: true });
  writeFileSync(
    join(workspacePath(home), "profiles", "coding.yaml"),
    "context:\n  - team-rules\nskills:\n  - review-pr\n",
  );
  writeFileSync(
    configPath(home),
    `schema_version: 2\nworkspace: ${workspacePath(home)}\nbindings: []\n`,
  );
  return home;
}

function plain(text: string): string {
  return text
    .replace(/\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\s+/g, " ");
}

function capturedStreams(): {
  readonly output: PassThrough;
  readonly stderr: PassThrough;
  readonly humanText: () => string;
  readonly errorText: () => string;
} {
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
  while (!plain(text()).includes(fragment)) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for output fragment: ${fragment}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function invokeInstall(
  home: string,
  arguments_: readonly string[],
  input: PassThrough = nonInteractiveInput(),
): Promise<{ readonly exitCode: number; readonly streams: ReturnType<typeof capturedStreams> }> {
  const streams = capturedStreams();
  const outcome = await runInstallCommand({
    home,
    arguments: arguments_,
    stdout: streams.output as Writable & { isTTY?: boolean },
    stderr: streams.stderr as Writable & { isTTY?: boolean },
    input,
  });
  return { exitCode: outcome.exitCode, streams };
}

async function invokeUninstall(
  home: string,
  arguments_: readonly string[],
  input: PassThrough = nonInteractiveInput(),
): Promise<{ readonly exitCode: number; readonly streams: ReturnType<typeof capturedStreams> }> {
  const streams = capturedStreams();
  const outcome = await runUninstallCommand({
    home,
    arguments: arguments_,
    stdout: streams.output as Writable & { isTTY?: boolean },
    stderr: streams.stderr as Writable & { isTTY?: boolean },
    input,
  });
  return { exitCode: outcome.exitCode, streams };
}

async function invokeUpdate(
  home: string,
  arguments_: readonly string[],
  input: PassThrough = nonInteractiveInput(),
): Promise<{ readonly exitCode: number; readonly streams: ReturnType<typeof capturedStreams> }> {
  const streams = capturedStreams();
  const projectArgument = arguments_.find((argument) => !argument.startsWith("-"));
  const selection: ProjectBindingSelection = projectArgument === undefined
    ? { kind: "all" }
    : { command: "update", kind: "project", match: "exact", target: projectArgument };
  const outcome = await runApplyCommand({
    home,
    selection,
    json: arguments_.includes("--json"),
    removeChanged: arguments_.includes("--remove-changed"),
    replaceChanged: arguments_.includes("--replace-changed"),
    verbose: false,
    stdout: streams.output as Writable & { isTTY?: boolean },
    stderr: streams.stderr as Writable & { isTTY?: boolean },
    input,
  });
  return { exitCode: outcome.exitCode, streams };
}

async function readDetails(
  home: string,
  arguments_: readonly string[],
): Promise<{ readonly exitCode: number; readonly output: string; readonly error: string }> {
  const streams = capturedStreams();
  const outcome = await runDetailsCommand({
    home,
    arguments: arguments_,
    stdout: streams.output as Writable & { isTTY?: boolean },
    stderr: streams.stderr as Writable & { isTTY?: boolean },
  });
  return { exitCode: outcome.exitCode, output: streams.humanText(), error: streams.errorText() };
}

async function detailsEntries(home: string): Promise<readonly OperationHistoryEntry[]> {
  const result = await readDetails(home, ["--list", "--json"]);
  expect(result.exitCode).toBe(0);
  return (JSON.parse(result.output) as { entries: readonly OperationHistoryEntry[] }).entries;
}

describe("integrated completed-operation evidence across later attempts (AC2)", () => {
  test("a completed install stays readable by identity after a no-op and a declined uninstall", async () => {
    const home = await setupHome();
    const projectPath = projectDirectory();
    try {
      expect((await invokeInstall(home, ["coding", projectPath, "--agent", "codex", "--auto-confirm"])).exitCode).toBe(0);
      // A routine update over settled work records a no-op entry.
      expect((await invokeUpdate(home, ["--all"])).exitCode).toBe(0);
      // Declining the general uninstall confirmation records a cancelled entry with zero writes.
      const declinedInput = fakeInteractiveInput();
      const declinedStreams = capturedStreams();
      const declined = runUninstallCommand({
        home,
        arguments: ["--all"],
        stdout: declinedStreams.output as Writable & { isTTY?: boolean },
        stderr: declinedStreams.stderr as Writable & { isTTY?: boolean },
        input: declinedInput,
      });
      await waitForOutput(declinedStreams.humanText, "Uninstall as listed?");
      declinedInput.write("n\n");
      expect((await declined).exitCode).toBe(1);

      const entries = await detailsEntries(home);
      expect(entries.map((entry) => entry.command)).toEqual(["uninstall", "update", "install"]);
      expect(entries.map((entry) => entry.outcome)).toEqual(["cancelled", "no-op", "succeeded"]);
      const installEntry = entries.find((entry) => entry.command === "install")!;
      expect(installEntry.projects[0]!.result).toBe("completed");

      // The completed install's rendered evidence survives both later attempts.
      const rendered = await readDetails(home, [installEntry.id]);
      expect(rendered.exitCode).toBe(0);
      const renderedText = humanText(rendered.output);
      expect(renderedText).toContain("succeeded");
      expect(renderedText).toContain(".codex/hooks.json");

      // The cancelled latest entry reports cancellation — never success.
      const latest = await readDetails(home, []);
      expect(latest.exitCode).toBe(0);
      const latestText = humanText(latest.output);
      expect(latestText).toContain("cancelled");
      expect(latestText).toContain("declined");
      expect(latestText).not.toContain(".codex/hooks.json");
      expect(latestText).not.toContain("up to date");
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(projectPath, { recursive: true, force: true });
    }
  });

  // The fault below relies on filesystem permission enforcement: as root,
  // 0o500 does not block removal, so the expected failure would not
  // reproduce; skip rather than assert from a non-faulting run (the same
  // guard sibling #511 adopted for its permission fault).
  test.skipIf(process.getuid?.() === 0)(
    "a failed uninstall is recorded and rendered as failed, never as success",
    async () => {
    const home = await setupHome();
    const projectPath = projectDirectory();
    try {
      expect((await invokeInstall(home, ["coding", projectPath, "--agent", "codex", "--auto-confirm"])).exitCode).toBe(0);
      // A read-only Project root makes the proven removal fail mid-transaction.
      chmodSync(projectPath, 0o500);
      let uninstall: { readonly exitCode: number; readonly streams: ReturnType<typeof capturedStreams> };
      try {
        uninstall = await invokeUninstall(home, ["--all", "--auto-confirm"]);
        expect(uninstall.exitCode).toBe(1);
      } finally {
        chmodSync(projectPath, 0o700);
      }

      const entries = await detailsEntries(home);
      const latest = entries[0]!;
      expect(latest.command).toBe("uninstall");
      expect(latest.outcome).toBe("failed");
      expect(latest.failure).toBeDefined();
      expect(latest.projects[0]!.result).toBe("failed");

      // The rendered history evidence carries the failure — not a success claim.
      const rendered = await readDetails(home, [latest.id]);
      expect(rendered.exitCode).toBe(0);
      const renderedText = humanText(rendered.output);
      expect(renderedText).toContain("failed");
      expect(renderedText).toContain("Failed:");
      expect(renderedText).not.toContain("up to date");

      // The compact invocation output reports the failure on the run itself:
      // what stopped, the restoration evidence, and the same-scope retry.
      const compactText = plain(uninstall.streams.errorText());
      expect(compactText).toContain("uninstall stopped at");
      expect(compactText).toContain(projectPath);
      expect(compactText).toContain("were restored where possible");
      expect(compactText).toContain("apkit uninstall --all --auto-confirm");
      expect(compactText).not.toContain("up to date");
    } finally {
      chmodSync(projectPath, 0o700);
      rmSync(home, { recursive: true, force: true });
      rmSync(projectPath, { recursive: true, force: true });
    }
    },
  );

  test("a failed selection restore stays explicit from history recording through rendered evidence", async () => {
    const home = await setupHome();
    const projectPath = projectDirectory();
    try {
      expect((await invokeInstall(home, ["coding", projectPath, "--agent", "codex", "--auto-confirm"])).exitCode).toBe(0);
      // A real failed recovery (DEC-006) produced by the installer through
      // the same double fault the recovery suite uses: the state write
      // faults after removal, then the binding-restore publish faults too.
      // The fault object below is installer behavior, not a hand-built
      // fixture — if recovery stops reporting this way, the test fails.
      const alwaysFailingWriteState: typeof writeInstallationState = async () => {
        throw new Error("injected Installation State fault");
      };
      // Fail the binding-restore publication (the second config temp write).
      let configPublishes = 0;
      const failingFileSystem = {
        ...defaultFileSystem,
        writeFile: (async (...args: Parameters<typeof defaultFileSystem.writeFile>) => {
          if (typeof args[0] === "string" && args[0].endsWith(".tmp")) {
            configPublishes += 1;
            if (configPublishes === 2) throw new Error("injected Local Configuration fault");
          }
          return defaultFileSystem.writeFile(...args);
        }) as typeof defaultFileSystem.writeFile,
      };
      const faulted = await executeUninstall(home, {
        all: true,
        writeInstallationState: alwaysFailingWriteState,
        bindFileSystem: failingFileSystem,
      });
      expect(faulted.failed?.selectionRestored).toBe(false);
      expect(faulted.failed?.restoreError).toContain("injected Local Configuration fault");
      const recording = beginLifecycleOperationRecording();
      recording.collect(uninstallRecording(faulted, { selection: "all" }));
      const finishStreams = capturedStreams();
      const finished = await finishLifecycleOperationRecording({
        recording,
        home,
        command: "uninstall",
        startedAt: Date.now(),
        finishedAt: Date.now(),
        stderr: finishStreams.stderr as Writable & { isTTY?: boolean },
      });
      expect(finished).toBe("saved");
      const entry = (await detailsEntries(home))[0]!;
      expect(entry.command).toBe("uninstall");
      const stored = (await detailsEntries(home)).find((candidate) => candidate.id === entry.id)!;
      expect(stored.outcome).toBe("failed");
      expect(stored.projects[0]!.restored).toBe(false);
      expect(stored.failure).toContain("previous state restore failed");
      expect(stored.failure).toContain("injected Local Configuration fault");

      // The rendered details evidence keeps the restore failure explicit.
      const rendered = await readDetails(home, [entry.id]);
      const renderedText = humanText(rendered.output);
      expect(renderedText).toContain("failed");
      expect(renderedText).toContain("previous state restore failed");
      expect(renderedText).toContain("injected Local Configuration fault");
      expect(renderedText).not.toContain("up to date");

      // The compact stopped-removal diagnostic names the restore failure and
      // offers the same-scope retry — it never presents verified success.
      // The failed result above is installer-produced; the live-command
      // wiring of this same call site is pinned by the neighboring
      // failed-uninstall test, including the retry content.
      if (faulted.failed === undefined) throw new Error("expected a failed uninstall");
      const document = uninstallExecutionFailureDocument({
        failed: faulted.failed,
        completed: [],
        unattempted: [],
        retryArguments: [
          { kind: "text", value: "uninstall" },
          { kind: "text", value: "--all" },
          { kind: "text", value: "--auto-confirm" },
        ],
      });
      const output = new PassThrough() as PassThrough & { isTTY?: boolean };
      const chunks: Buffer[] = [];
      output.on("data", (chunk: Buffer) => chunks.push(chunk));
      writeHumanDocument(output, document, terminalPresentationContext(output));
      const compactText = humanText(Buffer.concat(chunks).toString());
      expect(compactText).toContain("Previous selection/output restore failed: injected Local Configuration fault");
      expect(compactText).toContain("uninstall --all --auto-confirm");
      expect(compactText).not.toContain("up to date");
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(projectPath, { recursive: true, force: true });
    }
  });
});

describe("integrated uninstall diff view (US-020 interaction)", () => {
  test("uninstall offers the shared optional diff before deleting changed output", async () => {
    const home = await setupHome();
    const projectPath = projectDirectory();
    try {
      await executeInstall(home, { profile: "coding", hosts: ["codex"], project: projectPath });
      const { realpathSync } = await import("node:fs");
      const { readInstallationState } = await import("../installer/installation-state.js");
      const { ordinaryReceipts } = await import("../installer/ownership-state.js");
      const state = await readInstallationState(home);
      const receipt = ordinaryReceipts(state).find((entry) => entry.project === realpathSync(projectPath));
      if (receipt === undefined || receipt.outputs.length === 0) {
        throw new Error("fixture install produced no output");
      }
      const driftedOutput = join(projectPath, receipt.outputs[0]!.path);
      appendFileSync(driftedOutput, "\nIndependent user edit.\n");

      const streams = capturedStreams();
      const input = fakeInteractiveInput();
      const pending = runUninstallCommand({
        home,
        arguments: ["--project", projectPath],
        stdout: streams.output as Writable & { isTTY?: boolean },
        stderr: streams.stderr as Writable & { isTTY?: boolean },
        input,
      });
      await waitForOutput(streams.humanText, "Uninstall as listed?");
      input.write("y\n");
      await waitForOutput(streams.humanText, "Changed generated files:");
      // The optional diff is a consent view, not consent: viewing returns to
      // the same review and the deletion still needs an explicit yes.
      input.write("d\n");
      await waitForOutput(streams.humanText, "Current on-disk versus planned:");
      expect(plain(streams.humanText())).toContain("Independent user edit.");
      input.write("y\n");
      const outcome = await pending;
      expect(outcome.exitCode).toBe(0);
      expect(existsSync(driftedOutput)).toBe(false);
      expect(readFileSync(configPath(home), "utf8")).not.toContain(projectPath);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(projectPath, { recursive: true, force: true });
    }
  });
});

describe("integrated generated-source notice (US-021 interaction)", () => {
  test("a real install writes the notice into Skill, Context, and Host-configuration output", async () => {
    const home = await setupHome();
    const projectPath = projectDirectory();
    try {
      expect(
        (
          await invokeInstall(home, [
            "coding",
            projectPath,
            "--agent",
            "claude",
            "--agent",
            "opencode",
            "--auto-confirm",
          ])
        ).exitCode,
      ).toBe(0);

      const skillEntry = readFileSync(join(projectPath, ".claude", "skills", "review-pr", "SKILL.md"), "utf8");
      const fenceEnd = skillEntry.indexOf("---", 3);
      expect(fenceEnd).toBeGreaterThan(0);
      const frontmatterBody = skillEntry.slice("---\n".length, fenceEnd);
      const body = skillEntry.slice(fenceEnd + "---".length);
      // The frontmatter stays valid and notice-free; the notice is the first
      // body line after frontmatter, and the authored body is preserved.
      expect(parseYaml(frontmatterBody)).toMatchObject({ name: "review-pr" });
      expect(plain(frontmatterBody)).not.toContain("Generated by apkit");
      expect(body.trimStart().startsWith("<!-- Generated by apkit.")).toBe(true);
      expect(body).toContain("Preserved body bytes.");

      const contextOutput = readFileSync(join(projectPath, ".claude", "rules", "agent-profile-kit.md"), "utf8");
      expect(contextOutput).toContain("Generated by apkit.");
      expect(contextOutput).toContain("Always preserve the project boundary.");

      // Comment-capable Host configuration carries the notice as a valid
      // comment and keeps parsing: the notice never becomes configuration.
      const hostConfig = readFileSync(join(projectPath, ".opencode", "opencode.jsonc"), "utf8");
      expect(hostConfig.startsWith("// Generated by apkit.")).toBe(true);
      expect(() => parseGeneratedJsonc(hostConfig)).not.toThrow();
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(projectPath, { recursive: true, force: true });
    }
  });
});

describe("integrated membership edits and partial Host removal (AC1)", () => {
  test("configure profile membership reaches installations through the printed update action", async () => {
    const home = await setupHome();
    const projectPath = projectDirectory();
    try {
      expect((await invokeInstall(home, ["coding", projectPath, "--agent", "codex", "--auto-confirm"])).exitCode).toBe(0);
      expect(existsSync(join(projectPath, ".agents", "skills", "deploy", "SKILL.md"))).toBe(false);

      const configureStreams = capturedStreams();
      const configured = await runConfigureCommand({
        home,
        arguments: [
          "profile",
          "coding",
          "--context",
          "team-rules",
          "--skill",
          "review-pr",
          "--skill",
          "deploy",
          "--auto-confirm",
        ],
        stdout: configureStreams.output as Writable & { isTTY?: boolean },
        stderr: configureStreams.stderr as Writable & { isTTY?: boolean },
        input: nonInteractiveInput(),
      });
      expect(configured.exitCode).toBe(0);
      // The receipt directs the user to update; only installed output is
      // untouched until that explicit next action runs (US-009).
      expect(plain(configureStreams.humanText())).toContain("apkit update");
      expect(existsSync(join(projectPath, ".agents", "skills", "deploy", "SKILL.md"))).toBe(false);

      expect((await invokeUpdate(home, ["--all"])).exitCode).toBe(0);
      const addedSkill = readFileSync(join(projectPath, ".agents", "skills", "deploy", "SKILL.md"), "utf8");
      expect(addedSkill).toContain("Preserved body bytes.");
      expect(
        readFileSync(join(projectPath, ".agents", "skills", "review-pr", "SKILL.md"), "utf8"),
      ).toContain("Preserved body bytes.");
      const latest = (await detailsEntries(home))[0]!;
      expect(latest.command).toBe("update");
      expect(latest.outcome).toBe("succeeded");
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(projectPath, { recursive: true, force: true });
    }
  });

  test("removing one Host keeps the other Host working with shared output preserved", async () => {
    const home = await setupHome();
    const projectPath = projectDirectory();
    try {
      expect(
        (
          await invokeInstall(home, [
            "coding",
            projectPath,
            "--agent",
            "codex",
            "--agent",
            "opencode",
            "--auto-confirm",
          ])
        ).exitCode,
      ).toBe(0);
      expect(existsSync(join(projectPath, ".opencode", "opencode.jsonc"))).toBe(true);

      const removed = await invokeUninstall(home, ["--project", projectPath, "--agent", "opencode", "--auto-confirm"]);
      expect(removed.exitCode).toBe(0);
      const receipt = plain(removed.streams.humanText());
      expect(receipt).toContain("opencode");
      expect(receipt).not.toContain("up to date");

      // The removed Host's exclusive generated files are gone; output the
      // remaining Host still consumes — including shared Skill output — is
      // preserved. Harmless empty Host directories may linger (OOS-003/N6:
      // no empty-directory bookkeeping), so the bound is file-level.
      expect(existsSync(join(projectPath, ".opencode", "opencode.jsonc"))).toBe(false);
      expect(existsSync(join(projectPath, ".agent-profile-kit", "opencode", "context.md"))).toBe(false);
      expect(
        readFileSync(join(projectPath, ".agent-profile-kit", "codex", "context.md"), "utf8"),
      ).toContain("Always preserve the project boundary.");
      expect(
        readFileSync(join(projectPath, ".agents", "skills", "review-pr", "SKILL.md"), "utf8"),
      ).toContain("Preserved body bytes.");
      expect(readFileSync(configPath(home), "utf8")).not.toContain("opencode");

      const latest = (await detailsEntries(home))[0]!;
      expect(latest.command).toBe("uninstall");
      expect(latest.outcome).toBe("succeeded");
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(projectPath, { recursive: true, force: true });
    }
  });
});
