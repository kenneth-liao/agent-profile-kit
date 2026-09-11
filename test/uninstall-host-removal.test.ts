/**
 * Partial Host removal (ticket #498, spec #491 US-004/US-008, DEC-003/
 * DEC-005/DEC-006/DEC-014, TEST-002/TEST-004/TEST-005): `uninstall --host`
 * narrows removal to the requested Hosts within the selected Project/Profile
 * scope, preserves shared output and the survivors' remembered selection,
 * routes last-Host removal through the complete-uninstall result, authorizes
 * changed deletions via `--remove-changed` and changed survivor rewrites via
 * `--replace-changed` (each conditional on the actual plan), and restores
 * the prior Host selection/output when a faulted partial removal fails.
 * End-to-end through the public lifecycle calls with real Projects.
 */
import { describe, expect, test } from "bun:test";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, type Writable } from "node:stream";

import { parse as parseYaml } from "yaml";
import { runUninstallCommand } from "../cli/uninstall-command.js";
import { InstallerToolError } from "../installer/tool-errors.js";
import {
  normalizeUninstallHosts,
  survivingHostsForRemoval,
} from "../installer/uninstall-application.js";
import { executeInstall } from "../installer/install-application.js";
import { readInstallationState, writeInstallationState } from "../installer/installation-state.js";
import { ordinaryReceipts } from "../installer/ownership-state.js";
import { executeUninstall } from "../installer/uninstall-application.js";
import { initializeWorkspace } from "../installer/initialize-workspace.js";

const temporaryDirectories: string[] = [];

function isolatedHome(): string {
  const home = mkdtempSync(join(tmpdir(), "agent-profile-kit-uninstall-host-"));
  temporaryDirectories.push(home);
  return home;
}

function projectDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), "agent-profile-kit-uninstall-host-project-"));
  temporaryDirectories.push(path);
  return path;
}

function workspacePath(home: string): string {
  return join(home, ".agents", "agent-profile-kit", "workspace");
}

function configPath(home: string): string {
  return join(home, ".agents", "agent-profile-kit", "config.yaml");
}

function writeSkillProfile(home: string, name: string): void {
  mkdirSync(join(workspacePath(home), "context"), { recursive: true });
  writeFileSync(
    join(workspacePath(home), "context", "team-rules.md"),
    "---\nid: team-rules\ndependencies: []\n---\nAlways preserve the project boundary.\n",
  );
  const skillRoot = join(workspacePath(home), "skills", "review-pr");
  mkdirSync(skillRoot, { recursive: true });
  writeFileSync(
    join(skillRoot, "SKILL.md"),
    "---\nname: review-pr\ndescription: Skill review-pr.\n---\n\n# review-pr\n\nReview with care.\n",
  );
  mkdirSync(join(workspacePath(home), "profiles"), { recursive: true });
  writeFileSync(
    join(workspacePath(home), "profiles", `${name}.yaml`),
    `id: ${name}\ncontext:\n  - team-rules\nskills:\n  - review-pr\n`,
  );
}

async function setupHome(): Promise<string> {
  const home = isolatedHome();
  await initializeWorkspace(home);
  writeSkillProfile(home, "engineering");
  writeFileSync(
    configPath(home),
    `schema_version: 2\nworkspace: ${workspacePath(home)}\nbindings: []\n`,
  );
  return home;
}

function nonInteractiveInput(): PassThrough {
  return new PassThrough();
}

function fakeInteractiveInput(): PassThrough & { isTTY: true } {
  const stream = new PassThrough() as PassThrough & { isTTY: true };
  stream.isTTY = true;
  return stream;
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

async function receiptFor(home: string, project: string) {
  const state = await readInstallationState(home);
  const receipt = ordinaryReceipts(state).find((entry) => entry.project === realpathSync(project));
  if (receipt === undefined) throw new Error(`no ordinary receipt for ${project}`);
  return receipt;
}

/**
 * A recorded file output exclusive to the removed Host (outside shared
 * Skill delivery): safe to read, drift, and assert deletion on.
 */
async function exclusiveOutputPath(home: string, project: string): Promise<string> {
  const receipt = await receiptFor(home, project);
  const exclusive = receipt.outputs.find(
    (output) => output.type === "file" && !output.path.startsWith(".agents/skills/"),
  );
  if (exclusive === undefined) {
    throw new Error(
      `fixture assumption broken: no Host-exclusive file output for ${project}; ` +
        `recorded: ${receipt.outputs.map((output) => `${output.type}:${output.path}`).join(", ")}`,
    );
  }
  return join(project, exclusive.path);
}

/**
 * A recorded shared Skill output retained by the surviving Hosts. Skill
 * delivery records directory roots, so content assertions address the
 * package's SKILL.md while existence assertions address the root.
 */
async function sharedOutputPaths(home: string, project: string): Promise<{
  readonly root: string;
  readonly skillFile: string;
}> {
  const receipt = await receiptFor(home, project);
  const shared = receipt.outputs.find((output) => output.path.startsWith(".agents/skills/"));
  if (shared === undefined) {
    throw new Error(
      `fixture assumption broken: no shared Skill output for ${project}; ` +
        `recorded: ${receipt.outputs.map((output) => `${output.type}:${output.path}`).join(", ")}`,
    );
  }
  return { root: join(project, shared.path), skillFile: join(project, shared.path, "SKILL.md") };
}

function bindingHosts(home: string, project: string): string[] {
  const parsed = parseYaml(readFileSync(configPath(home), "utf8")) as {
    readonly bindings: readonly { readonly project: string; readonly hosts: readonly string[] }[];
  };
  const binding = parsed.bindings.find((entry) => entry.project === project);
  if (binding === undefined) throw new Error(`no binding for ${project}`);
  return [...binding.hosts];
}

function cleanup(): void {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("uninstall --host surviving-set computation", () => {
  test("requested Hosts normalize to SUPPORTED_HOSTS order with duplicates collapsed", () => {
    expect(normalizeUninstallHosts(["pi", "codex", "pi"])).toEqual(["codex", "pi"]);
  });

  test("unknown Hosts throw the shared unsupported-host fact before any write", () => {
    let caught: unknown;
    try {
      normalizeUninstallHosts(["borked"]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(InstallerToolError);
    expect((caught as InstallerToolError).fact.kind).toBe("unsupported-host");
  });

  test("survivors subtract the removed Hosts in bound order", () => {
    expect(survivingHostsForRemoval(["codex", "pi"], ["codex"])).toEqual(["pi"]);
    expect(survivingHostsForRemoval(["codex", "pi"], ["codex", "pi"])).toEqual([]);
    expect(survivingHostsForRemoval(["codex", "pi"], ["pi"])).toEqual(["codex"]);
  });
});

describe("uninstall --host partial removal", () => {
  test("removes only the requested Host's output and narrows the remembered selection", async () => {
    const home = await setupHome();
    const project = projectDirectory();
    const other = projectDirectory();
    try {
      await executeInstall(home, { profile: "engineering", hosts: ["codex", "pi"], project });
      await executeInstall(home, { profile: "engineering", hosts: ["codex", "pi"], project: other });
      const codexOutput = await exclusiveOutputPath(home, project);
      const shared = await sharedOutputPaths(home, project);
      const sharedBytes = readFileSync(shared.skillFile, "utf8");

      const result = await executeUninstall(home, { project, hosts: ["codex"] });

      expect(result.failed).toBeUndefined();
      expect(result.skipped).toEqual([]);
      expect(result.unattempted).toEqual([]);
      expect(result.completed).toHaveLength(1);
      expect(result.completed[0]!.removedHosts).toEqual(["codex"]);

      // The removed Host's exclusive output is gone; shared output survives byte-identical.
      expect(existsSync(codexOutput)).toBe(false);
      expect(existsSync(shared.root)).toBe(true);
      expect(readFileSync(shared.skillFile, "utf8")).toBe(sharedBytes);

      // The remembered selection narrows to the survivors (binding and receipt agree).
      expect(bindingHosts(home, project)).toEqual(["pi"]);
      const receipt = await receiptFor(home, project);
      expect(Object.keys(receipt.hosts).sort()).toEqual(["pi"]);
      expect(receipt.outputs.some((output) => output.path.startsWith(".agents/skills/"))).toBe(true);

      // The unselected Project is untouched, and a later update does not recreate codex output.
      const otherCodexOutput = await exclusiveOutputPath(home, other);
      expect(existsSync(otherCodexOutput)).toBe(true);
      const { applyApplication } = await import("../installer/commands.js");
      await applyApplication(home, {});
      expect(existsSync(codexOutput)).toBe(false);
      expect(existsSync(shared.root)).toBe(true);
      expect(bindingHosts(home, project)).toEqual(["pi"]);
    } finally {
      cleanup();
    }
  });

  test("removing the last Host uses the complete-uninstall result path", async () => {
    const home = await setupHome();
    const project = projectDirectory();
    try {
      await executeInstall(home, { profile: "engineering", hosts: ["codex"], project });
      const outputs = (await receiptFor(home, project)).outputs.map((output) =>
        join(project, output.path),
      );
      expect(outputs.length).toBeGreaterThan(0);

      const result = await executeUninstall(home, { project, hosts: ["codex"] });

      expect(result.failed).toBeUndefined();
      expect(result.completed).toHaveLength(1);
      // The complete path carries no partial delta: the installation is forgotten.
      expect(result.completed[0]!.removedHosts).toBeUndefined();
      for (const path of outputs) expect(existsSync(path)).toBe(false);
      expect(readFileSync(configPath(home), "utf8")).not.toContain(project);
      const state = await readInstallationState(home);
      expect(
        state.receipts.some((entry) => entry.project === realpathSync(project)),
      ).toBe(false);
    } finally {
      cleanup();
    }
  });

  test("Host-only non-interactive invocation without scope refuses with a runnable equivalent and zero writes", async () => {
    const home = await setupHome();
    const project = projectDirectory();
    try {
      await executeInstall(home, { profile: "engineering", hosts: ["codex", "pi"], project });
      const codexOutput = await exclusiveOutputPath(home, project);
      const shared = await sharedOutputPaths(home, project);

      const streams = capturedStreams();
      const outcome = await runUninstallCommand({
        home,
        arguments: ["--host", "codex", "--auto-confirm"],
        stdout: streams.output as Writable & { isTTY?: boolean },
        stderr: streams.stderr as Writable & { isTTY?: boolean },
        input: nonInteractiveInput(),
      });

      expect(outcome.exitCode).toBe(1);
      expect(plain(streams.errorText())).toContain("--all");
      expect(plain(streams.errorText())).toContain("--host codex");
      // Zero writes: selection and output survive.
      expect(bindingHosts(home, project)).toEqual(["codex", "pi"]);
      expect(existsSync(codexOutput)).toBe(true);
      expect(existsSync(shared.root)).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("bare-interactive --host refuses with a scoped equivalent and zero writes", async () => {
    const home = await setupHome();
    const project = projectDirectory();
    try {
      await executeInstall(home, { profile: "engineering", hosts: ["codex", "pi"], project });
      const codexOutput = await exclusiveOutputPath(home, project);

      const streams = capturedStreams();
      const outcome = await runUninstallCommand({
        home,
        arguments: ["--host", "codex"],
        stdout: streams.output as Writable & { isTTY?: boolean },
        stderr: streams.stderr as Writable & { isTTY?: boolean },
        input: fakeInteractiveInput(),
      });

      expect(outcome.exitCode).toBe(1);
      expect(plain(streams.errorText())).toContain("--host codex");
      expect(bindingHosts(home, project)).toEqual(["codex", "pi"]);
      expect(existsSync(codexOutput)).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("a Host bound by no selected Project reports no match with no writes", async () => {
    const home = await setupHome();
    const project = projectDirectory();
    try {
      await executeInstall(home, { profile: "engineering", hosts: ["codex"], project });
      const codexOutput = await exclusiveOutputPath(home, project);

      const streams = capturedStreams();
      const outcome = await runUninstallCommand({
        home,
        arguments: ["--project", project, "--host", "pi", "--auto-confirm"],
        stdout: streams.output as Writable & { isTTY?: boolean },
        stderr: streams.stderr as Writable & { isTTY?: boolean },
        input: nonInteractiveInput(),
      });

      expect(outcome.exitCode).toBe(1);
      expect(plain(streams.errorText())).toContain("pi");
      expect(bindingHosts(home, project)).toEqual(["codex"]);
      expect(existsSync(codexOutput)).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("an unknown Host fails before any write", async () => {
    const home = await setupHome();
    const project = projectDirectory();
    try {
      await executeInstall(home, { profile: "engineering", hosts: ["codex", "pi"], project });
      const codexOutput = await exclusiveOutputPath(home, project);

      const streams = capturedStreams();
      const outcome = await runUninstallCommand({
        home,
        arguments: ["--project", project, "--host", "borked", "--auto-confirm"],
        stdout: streams.output as Writable & { isTTY?: boolean },
        stderr: streams.stderr as Writable & { isTTY?: boolean },
        input: nonInteractiveInput(),
      });

      expect(outcome.exitCode).toBe(1);
      expect(plain(streams.errorText())).toContain("unsupported Agent Host 'borked'");
      expect(bindingHosts(home, project)).toEqual(["codex", "pi"]);
      expect(existsSync(codexOutput)).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("interactive confirmation names the removed and kept Hosts", async () => {
    const home = await setupHome();
    const project = projectDirectory();
    try {
      await executeInstall(home, { profile: "engineering", hosts: ["codex", "pi"], project });

      const streams = capturedStreams();
      const input = fakeInteractiveInput();
      const pending = runUninstallCommand({
        home,
        arguments: ["--project", project, "--host", "codex"],
        stdout: streams.output as Writable & { isTTY?: boolean },
        stderr: streams.stderr as Writable & { isTTY?: boolean },
        input,
      });
      await waitForOutput(streams.humanText, "Uninstall as listed?");
      expect(plain(streams.humanText())).toContain("remove codex");
      expect(plain(streams.humanText())).toContain("keep pi");
      input.write("y\n");
      const outcome = await pending;
      expect(outcome.exitCode).toBe(0);
      expect(plain(streams.humanText())).toContain("Removed Host codex from 1 Project");
      expect(bindingHosts(home, project)).toEqual(["pi"]);
    } finally {
      cleanup();
    }
  });

  test("JSON success carries the removed Hosts", async () => {
    const home = await setupHome();
    const project = projectDirectory();
    try {
      await executeInstall(home, { profile: "engineering", hosts: ["codex", "pi"], project });

      const streams = capturedStreams();
      const outcome = await runUninstallCommand({
        home,
        arguments: ["--project", project, "--host", "codex", "--auto-confirm", "--json"],
        stdout: streams.output as Writable & { isTTY?: boolean },
        stderr: streams.stderr as Writable & { isTTY?: boolean },
        input: nonInteractiveInput(),
      });

      expect(outcome.exitCode).toBe(0);
      const payload = JSON.parse(streams.humanText()) as {
        schemaVersion: number;
        command: string;
        outcome: string;
        completed: { project: string; removedHosts?: string[] }[];
      };
      expect(payload.schemaVersion).toBe(15);
      expect(payload.command).toBe("uninstall");
      expect(payload.outcome).toBe("clean");
      expect(payload.completed[0]!.removedHosts).toEqual(["codex"]);
    } finally {
      cleanup();
    }
  });
});

describe("uninstall --host consent matrix (changed/clean x delete/rewrite)", () => {
  test("changed deletion without --remove-changed refuses naming only --remove-changed", async () => {
    const home = await setupHome();
    const project = projectDirectory();
    try {
      await executeInstall(home, { profile: "engineering", hosts: ["codex", "pi"], project });
      const codexOutput = await exclusiveOutputPath(home, project);
      const shared = await sharedOutputPaths(home, project);
      appendFileSync(codexOutput, "\nIndependent user edit.\n");

      const streams = capturedStreams();
      const outcome = await runUninstallCommand({
        home,
        arguments: ["--project", project, "--host", "codex", "--auto-confirm"],
        stdout: streams.output as Writable & { isTTY?: boolean },
        stderr: streams.stderr as Writable & { isTTY?: boolean },
        input: nonInteractiveInput(),
      });

      expect(outcome.exitCode).toBe(1);
      expect(plain(streams.errorText())).toContain("--remove-changed");
      expect(plain(streams.errorText())).not.toContain("--replace-changed");
      // Zero writes: the changed deletion and the healthy scope survive.
      expect(bindingHosts(home, project)).toEqual(["codex", "pi"]);
      expect(readFileSync(codexOutput, "utf8")).toContain("Independent user edit.");
      expect(existsSync(shared.root)).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("changed deletion with --remove-changed proceeds without --replace-changed", async () => {
    const home = await setupHome();
    const project = projectDirectory();
    try {
      await executeInstall(home, { profile: "engineering", hosts: ["codex", "pi"], project });
      const codexOutput = await exclusiveOutputPath(home, project);
      const shared = await sharedOutputPaths(home, project);
      const sharedBytes = readFileSync(shared.skillFile, "utf8");
      appendFileSync(codexOutput, "\nIndependent user edit.\n");

      const streams = capturedStreams();
      const outcome = await runUninstallCommand({
        home,
        arguments: ["--project", project, "--host", "codex", "--auto-confirm", "--remove-changed"],
        stdout: streams.output as Writable & { isTTY?: boolean },
        stderr: streams.stderr as Writable & { isTTY?: boolean },
        input: nonInteractiveInput(),
      });

      expect(outcome.exitCode).toBe(0);
      expect(existsSync(codexOutput)).toBe(false);
      expect(readFileSync(shared.skillFile, "utf8")).toBe(sharedBytes);
      expect(bindingHosts(home, project)).toEqual(["pi"]);
    } finally {
      cleanup();
    }
  });

  test("changed survivor rewrite without --replace-changed refuses naming only --replace-changed", async () => {
    const home = await setupHome();
    const project = projectDirectory();
    try {
      await executeInstall(home, { profile: "engineering", hosts: ["codex", "pi"], project });
      const shared = await sharedOutputPaths(home, project);
      // New Workspace source changes the surviving plan's bytes, and the
      // on-disk shared output drifted: the rewrite discards independent
      // changes, so it needs --replace-changed. Deletions stay clean.
      appendFileSync(join(workspacePath(home), "skills", "review-pr", "SKILL.md"), "\nSource update.\n");
      appendFileSync(shared.skillFile, "\nIndependent user edit.\n");

      const streams = capturedStreams();
      const outcome = await runUninstallCommand({
        home,
        arguments: ["--project", project, "--host", "codex", "--auto-confirm"],
        stdout: streams.output as Writable & { isTTY?: boolean },
        stderr: streams.stderr as Writable & { isTTY?: boolean },
        input: nonInteractiveInput(),
      });

      expect(outcome.exitCode).toBe(1);
      expect(plain(streams.errorText())).toContain("--replace-changed");
      expect(plain(streams.errorText())).not.toContain("--remove-changed");
      // Zero writes: the rewrite never landed and the selection stands.
      expect(bindingHosts(home, project)).toEqual(["codex", "pi"]);
      expect(readFileSync(shared.skillFile, "utf8")).toContain("Independent user edit.");
    } finally {
      cleanup();
    }
  });

  test("changed survivor rewrite with --replace-changed proceeds without --remove-changed", async () => {
    const home = await setupHome();
    const project = projectDirectory();
    try {
      await executeInstall(home, { profile: "engineering", hosts: ["codex", "pi"], project });
      const codexOutput = await exclusiveOutputPath(home, project);
      const shared = await sharedOutputPaths(home, project);
      appendFileSync(join(workspacePath(home), "skills", "review-pr", "SKILL.md"), "\nSource update.\n");
      appendFileSync(shared.skillFile, "\nIndependent user edit.\n");

      const streams = capturedStreams();
      const outcome = await runUninstallCommand({
        home,
        arguments: ["--project", project, "--host", "codex", "--auto-confirm", "--replace-changed"],
        stdout: streams.output as Writable & { isTTY?: boolean },
        stderr: streams.stderr as Writable & { isTTY?: boolean },
        input: nonInteractiveInput(),
      });

      expect(outcome.exitCode).toBe(0);
      // The rewrite carries the current source bytes; deletions needed no flag.
      expect(readFileSync(shared.skillFile, "utf8")).toContain("Source update.");
      expect(existsSync(codexOutput)).toBe(false);
      expect(bindingHosts(home, project)).toEqual(["pi"]);
    } finally {
      cleanup();
    }
  });

  test("clean survivor rewrite proceeds with no changed-file flag", async () => {
    const home = await setupHome();
    const project = projectDirectory();
    try {
      await executeInstall(home, { profile: "engineering", hosts: ["codex", "pi"], project });
      const codexOutput = await exclusiveOutputPath(home, project);
      const shared = await sharedOutputPaths(home, project);
      // Source update only: the rewrite discards no independent change, so
      // no --replace-changed; deletions are clean, so no --remove-changed.
      appendFileSync(join(workspacePath(home), "skills", "review-pr", "SKILL.md"), "\nSource update.\n");

      const streams = capturedStreams();
      const outcome = await runUninstallCommand({
        home,
        arguments: ["--project", project, "--host", "codex", "--auto-confirm"],
        stdout: streams.output as Writable & { isTTY?: boolean },
        stderr: streams.stderr as Writable & { isTTY?: boolean },
        input: nonInteractiveInput(),
      });

      expect(outcome.exitCode).toBe(0);
      expect(readFileSync(shared.skillFile, "utf8")).toContain("Source update.");
      expect(existsSync(codexOutput)).toBe(false);
      expect(bindingHosts(home, project)).toEqual(["pi"]);
    } finally {
      cleanup();
    }
  });
});

describe("uninstall --host faulted partial removal (TEST-005)", () => {
  test("a faulted partial restores the prior Host selection/output with completed retained and rest unattempted", async () => {
    const home = await setupHome();
    const parent = mkdtempSync(join(tmpdir(), "agent-profile-kit-uninstall-host-fleet-"));
    temporaryDirectories.push(parent);
    const names = ["aaa", "mmm", "zzz"] as const;
    for (const name of names) mkdirSync(join(parent, name), { recursive: true });
    const projects = names.map((name) => join(parent, name)) as [string, string, string];
    try {
      for (const project of projects) {
        await executeInstall(home, { profile: "engineering", hosts: ["codex", "pi"], project });
      }
      const mmmCodexOutput = await exclusiveOutputPath(home, projects[1]!);
      const mmmShared = await sharedOutputPaths(home, projects[1]!);
      const mmmSharedBytes = readFileSync(mmmShared.skillFile, "utf8");

      let stateWrites = 0;
      const failingWriteState: typeof writeInstallationState = async (stateHome, state) => {
        stateWrites += 1;
        // The first partial commit (aaa) succeeds; the second (mmm) faults.
        if (stateWrites === 2) throw new Error("injected Installation State fault");
        return writeInstallationState(stateHome, state);
      };

      const result = await executeUninstall(home, {
        all: true,
        hosts: ["codex"],
        writeInstallationState: failingWriteState,
      });

      expect(result.completed.map((entry) => entry.project)).toEqual([projects[0]]);
      expect(result.completed[0]!.removedHosts).toEqual(["codex"]);
      expect(result.failed?.project).toBe(projects[1]);
      expect(result.failed?.selectionRestored).toBe(true);
      expect(result.failed?.concurrentSelectionChange).toBe(false);
      expect(result.unattempted.map((entry) => entry.project)).toEqual([projects[2]]);

      // Completed stays narrowed; failed is restored; unattempted is untouched.
      expect(bindingHosts(home, projects[0]!)).toEqual(["pi"]);
      expect(bindingHosts(home, projects[1]!)).toEqual(["codex", "pi"]);
      expect(existsSync(mmmCodexOutput)).toBe(true);
      expect(readFileSync(mmmShared.skillFile, "utf8")).toBe(mmmSharedBytes);
      const mmmReceipt = await receiptFor(home, projects[1]!);
      expect(Object.keys(mmmReceipt.hosts).sort()).toEqual(["codex", "pi"]);
      expect(bindingHosts(home, projects[2]!)).toEqual(["codex", "pi"]);
    } finally {
      cleanup();
    }
  });

  test("a failed partial restore is explicit", async () => {
    const home = await setupHome();
    const project = projectDirectory();
    try {
      await executeInstall(home, { profile: "engineering", hosts: ["codex", "pi"], project });
      const codexOutput = await exclusiveOutputPath(home, project);
      const alwaysFailingWriteState: typeof writeInstallationState = async () => {
        throw new Error("injected Installation State fault");
      };
      // Fail the binding-restore publication (the second config temp write).
      let configPublishes = 0;
      const { defaultFileSystem } = await import("../installer/local-configuration-publication.js");
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

      const result = await executeUninstall(home, {
        project,
        hosts: ["codex"],
        writeInstallationState: alwaysFailingWriteState,
        bindFileSystem: failingFileSystem,
      });

      expect(result.completed).toEqual([]);
      expect(result.failed?.project).toBe(project);
      expect(result.failed?.selectionRestored).toBe(false);
      expect(result.failed?.restoreError).toContain("injected Local Configuration fault");
      // Staged output was rolled back while the receipt survives.
      expect(existsSync(codexOutput)).toBe(true);
      const receipt = await receiptFor(home, project);
      expect(Object.keys(receipt.hosts).sort()).toEqual(["codex", "pi"]);
    } finally {
      cleanup();
    }
  });
});
