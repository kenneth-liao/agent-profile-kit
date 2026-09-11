/**
 * Interactive uninstall target selection (ticket #499, spec #491 US-003/
 * US-004/US-005, DEC-003–DEC-005, TEST-003/TEST-004): bare interactive
 * uninstall opens the searchable Project picker with nothing pre-selected,
 * typing filters by name/path with arrows + Space, selections survive
 * filter changes, the complete picked scope is reviewed before execution,
 * whole-installation versus selected-Host removal is offered per flow, and
 * Host-only interactive input routes into Project selection. Cancellation
 * and empty selection never widen removal; completed picks execute through
 * the existing explicit contract with per-Project equivalents.
 * Public-command behavior only; real-PTY keyboard proof lives in
 * `uninstall-search-pty.test.ts`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, type Readable, type Writable } from "node:stream";

import { parse as parseYaml } from "yaml";
import { runUninstallCommand } from "../cli/uninstall-command.js";
import { APPLY_REPLACEMENT_QUESTION } from "../cli/presentation.js";
import { executeInstall } from "../installer/install-application.js";
import { readInstallationState } from "../installer/installation-state.js";
import { ordinaryReceipts } from "../installer/ownership-state.js";
import { initializeWorkspace } from "../installer/initialize-workspace.js";

const temporaryDirectories: string[] = [];

function isolatedHome(): string {
  const home = mkdtempSync(join(tmpdir(), "agent-profile-kit-uninstall-search-"));
  temporaryDirectories.push(home);
  return home;
}

function projectDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), "agent-profile-kit-uninstall-search-project-"));
  temporaryDirectories.push(path);
  return path;
}

function namedProjectDirectory(name: string): string {
  const base = mkdtempSync(join(tmpdir(), "agent-profile-kit-uninstall-search-"));
  temporaryDirectories.push(base);
  const path = join(base, name);
  mkdirSync(path, { recursive: true });
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

/** Human-timing settle between filter keystrokes (the 495 seam contract). */
function settle(ms = 80): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface StartedUninstall {
  readonly pending: Promise<{ exitCode: 0 | 1 | 2; streams: CapturedStreams }>;
  readonly streams: CapturedStreams;
}

function startUninstall(
  home: string,
  arguments_: readonly string[],
  input: Readable,
): StartedUninstall {
  const streams = capturedStreams();
  const pending = runUninstallCommand({
    home,
    arguments: arguments_,
    stdout: streams.output as Writable & { isTTY?: boolean },
    stderr: streams.stderr as Writable & { isTTY?: boolean },
    input,
  }).then((outcome) => ({ exitCode: outcome.exitCode, streams }));
  return { pending, streams };
}

async function setupInstalledPair(): Promise<{
  readonly home: string;
  readonly first: string;
  readonly second: string;
  readonly firstOutput: string;
  readonly secondOutput: string;
}> {
  const home = await setupHome();
  const first = projectDirectory();
  const second = projectDirectory();
  await executeInstall(home, { profile: "engineering", hosts: ["codex"], project: first });
  await executeInstall(home, { profile: "engineering", hosts: ["codex"], project: second });
  const state = await readInstallationState(home);
  const { realpathSync } = await import("node:fs");
  const firstReceipt = ordinaryReceipts(state).find((entry) => entry.project === realpathSync(first));
  const secondReceipt = ordinaryReceipts(state).find(
    (entry) => entry.project === realpathSync(second),
  );
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

function bindingHosts(home: string, project: string): string[] {
  const parsed = parseYaml(readFileSync(configPath(home), "utf8")) as {
    readonly bindings: readonly { readonly project: string; readonly hosts: readonly string[] }[];
  };
  const binding = parsed.bindings.find((entry) => entry.project === project);
  if (binding === undefined) throw new Error(`no binding for ${project}`);
  return [...binding.hosts];
}

describe("bare interactive uninstall Project selection", () => {
  test("the picker opens with nothing pre-selected and removes only the picked scope", async () => {
    const { home, first, second, firstOutput, secondOutput } = await setupInstalledPair();
    const input = fakeInteractiveInput();
    const started = startUninstall(home, [], input);
    await waitForOutput(started.streams.humanText, "Which Projects");
    expect(plain(started.streams.humanText())).toContain("space toggles");
    // Toggle only the highlighted Project, then submit: no pre-selection
    // means exactly one Project is picked here.
    input.write(" ");
    await settle();
    input.write("\r");
    await waitForOutput(started.streams.humanText, "Whole installations or selected Hosts?");
    input.write("\r");
    await waitForOutput(started.streams.humanText, "Uninstall as listed?");
    expect(plain(started.streams.humanText())).toContain("Picked 1 Project");
    expect(plain(started.streams.humanText())).toContain("Profile engineering");
    input.write("y\n");
    const result = await started.pending;
    expect(result.exitCode).toBe(0);
    // Exactly one Project removed; the other is untouched.
    const config = readFileSync(configPath(home), "utf8");
    const firstGone = !config.includes(first);
    const secondGone = !config.includes(second);
    expect(firstGone !== secondGone).toBe(true);
    expect(existsSync(firstGone ? secondOutput : firstOutput)).toBe(true);
    // The echo names the picked Project explicitly — never --all.
    expect(plain(started.streams.humanText())).toContain("--project");
    expect(plain(started.streams.humanText())).toContain("--auto-confirm");
    expect(plain(started.streams.humanText())).not.toContain("--all");
  });

  test("typing filters by name and selections survive filter changes", async () => {
    const home = await setupHome();
    const alpha = namedProjectDirectory("alpha-project");
    const beta = namedProjectDirectory("beta-project");
    await executeInstall(home, { profile: "engineering", hosts: ["codex"], project: alpha });
    await executeInstall(home, { profile: "engineering", hosts: ["codex"], project: beta });
    const input = fakeInteractiveInput();
    const started = startUninstall(home, [], input);
    await waitForOutput(started.streams.humanText, "Which Projects");
    // Filter to one Project and toggle it, then change the filter to the
    // other and toggle it too: the first selection must survive the filter
    // change. Each toggle waits for its filter-applied render, so no toggle
    // can race the asynchronous filter into becoming filter text.
    input.write("alpha");
    await waitForOutput(started.streams.humanText, "Filtered results for: alpha");
    input.write(" ");
    await settle(150);
    for (let index = 0; index < "alpha".length; index += 1) input.write("");
    input.write("beta");
    await waitForOutput(started.streams.humanText, "Filtered results for: beta");
    input.write(" ");
    await settle(150);
    input.write("\r");
    await waitForOutput(started.streams.humanText, "Whole installations or selected Hosts?");
    input.write("\r");
    await waitForOutput(started.streams.humanText, "Uninstall as listed?");
    // The complete picked scope — every selected Project — is reviewed,
    // and the selected count stayed visible after picking.
    expect(plain(started.streams.humanText())).toContain("Picked 2 Projects");
    expect(plain(started.streams.humanText())).toContain("alpha-project");
    expect(plain(started.streams.humanText())).toContain("beta-project");
    input.write("y\n");
    const result = await started.pending;
    expect(result.exitCode).toBe(0);
    const config = readFileSync(configPath(home), "utf8");
    expect(config).not.toContain(alpha);
    expect(config).not.toContain(beta);
  });

  test("empty selection is a no-op with zero writes, never all", async () => {
    const { home, first, second, firstOutput, secondOutput } = await setupInstalledPair();
    const input = fakeInteractiveInput();
    const started = startUninstall(home, [], input);
    await waitForOutput(started.streams.humanText, "Which Projects");
    input.write("\r");
    const result = await started.pending;
    expect(result.exitCode).toBe(1);
    expect(plain(started.streams.errorText())).toContain("no Projects selected");
    expect(plain(started.streams.errorText())).toContain("nothing was written");
    expect(plain(started.streams.errorText())).not.toContain("--all");
    expect(readFileSync(configPath(home), "utf8")).toContain(first);
    expect(readFileSync(configPath(home), "utf8")).toContain(second);
    expect(existsSync(firstOutput)).toBe(true);
    expect(existsSync(secondOutput)).toBe(true);
  });

  test("cancelling the picker leaves everything untouched", async () => {
    const { home, first, second, firstOutput, secondOutput } = await setupInstalledPair();
    const input = fakeInteractiveInput();
    const started = startUninstall(home, [], input);
    await waitForOutput(started.streams.humanText, "Which Projects");
    input.end();
    const result = await started.pending;
    expect(result.exitCode).toBe(1);
    expect(plain(started.streams.errorText())).toContain("cancelled");
    expect(readFileSync(configPath(home), "utf8")).toContain(first);
    expect(readFileSync(configPath(home), "utf8")).toContain(second);
    expect(existsSync(firstOutput)).toBe(true);
    expect(existsSync(secondOutput)).toBe(true);
  });

  test("declining the confirmation after picking leaves everything untouched with per-Project retries", async () => {
    const { home, first, second, firstOutput, secondOutput } = await setupInstalledPair();
    const input = fakeInteractiveInput();
    const started = startUninstall(home, [], input);
    await waitForOutput(started.streams.humanText, "Which Projects");
    input.write(" [B ");
    await settle();
    input.write("\r");
    await waitForOutput(started.streams.humanText, "Whole installations or selected Hosts?");
    input.write("\r");
    await waitForOutput(started.streams.humanText, "Uninstall as listed?");
    input.write("n\n");
    const result = await started.pending;
    expect(result.exitCode).toBe(1);
    expect(plain(started.streams.errorText())).toContain("nothing was written");
    // One runnable retry per picked Project — no combined widening line.
    expect(plain(started.streams.errorText()).match(/--project/g)?.length).toBe(2);
    expect(readFileSync(configPath(home), "utf8")).toContain(first);
    expect(readFileSync(configPath(home), "utf8")).toContain(second);
    expect(existsSync(firstOutput)).toBe(true);
    expect(existsSync(secondOutput)).toBe(true);
  });

  test("--auto-confirm answers the confirmation only, never the picks", async () => {
    const { home, first, second } = await setupInstalledPair();
    const input = fakeInteractiveInput();
    const started = startUninstall(home, ["--auto-confirm"], input);
    // The picker still opens: --auto-confirm never answers missing choices.
    await waitForOutput(started.streams.humanText, "Which Projects");
    input.write(" ");
    await settle();
    input.write("\r");
    await waitForOutput(started.streams.humanText, "Whole installations or selected Hosts?");
    input.write("\r");
    const result = await started.pending;
    expect(result.exitCode).toBe(0);
    expect(plain(started.streams.humanText())).not.toContain("Uninstall as listed?");
    const config = readFileSync(configPath(home), "utf8");
    expect((!config.includes(first)) !== (!config.includes(second))).toBe(true);
  });

  test("a binding added between pick and commit fails closed with zero writes", async () => {
    const { home, first, firstOutput } = await setupInstalledPair();
    const input = fakeInteractiveInput();
    const started = startUninstall(home, [], input);
    await waitForOutput(started.streams.humanText, "Which Projects");
    input.write(" ");
    await settle();
    input.write("\r");
    await waitForOutput(started.streams.humanText, "Whole installations or selected Hosts?");
    input.write("\r");
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
    // The retry reviews the changed scope instead of removing it unseen.
    expect(plain(started.streams.errorText())).not.toContain("--auto-confirm");
    expect(readFileSync(configPath(home), "utf8")).toContain(first);
    expect(readFileSync(configPath(home), "utf8")).toContain(added);
    expect(existsSync(firstOutput)).toBe(true);
  });

  test("lone --profile on a TTY keeps the explicit fleet flow, not the picker", async () => {
    const home = await setupHome();
    writeProfile(home, "docs");
    const first = projectDirectory();
    const second = projectDirectory();
    await executeInstall(home, { profile: "engineering", hosts: ["codex"], project: first });
    await executeInstall(home, { profile: "docs", hosts: ["codex"], project: second });
    const input = fakeInteractiveInput();
    const started = startUninstall(home, ["--profile", "engineering"], input);
    await waitForOutput(started.streams.humanText, "Uninstall as listed?");
    expect(plain(started.streams.humanText())).not.toContain("Which Projects");
    expect(plain(started.streams.humanText())).toContain(
      "every installation using Profile 'engineering'",
    );
    input.write("y\n");
    const result = await started.pending;
    expect(result.exitCode).toBe(0);
    expect(readFileSync(configPath(home), "utf8")).not.toContain(first);
    expect(readFileSync(configPath(home), "utf8")).toContain(second);
  });
});

describe("interactive Host-only routing and removal mode", () => {
  test("Host-only interactive input routes into Project selection with Hosts proposed", async () => {
    const home = await setupHome();
    const first = projectDirectory();
    const second = projectDirectory();
    await executeInstall(home, { profile: "engineering", hosts: ["codex", "pi"], project: first });
    await executeInstall(home, { profile: "engineering", hosts: ["codex", "pi"], project: second });
    const input = fakeInteractiveInput();
    const started = startUninstall(home, ["--host", "codex"], input);
    // No refusal: the picker opens instead.
    await waitForOutput(started.streams.humanText, "Which Projects");
    // Filter to a unique suffix of the first path so exactly that Project is
    // picked; the filtered-results render proves the filter applied before
    // the toggle, so no type-ahead race can widen the pick.
    const firstSuffix = first.slice(-6);
    input.write(firstSuffix);
    await waitForOutput(started.streams.humanText, `Filtered results for: ${firstSuffix}`);
    input.write(" ");
    await settle(150);
    input.write("\r");
    // The mode question opens with Host removal first and the named Host shown.
    await waitForOutput(started.streams.humanText, "Whole installations or selected Hosts?");
    expect(plain(started.streams.humanText())).toContain("Selected Hosts (codex)");
    input.write("\r");
    // The carried Host stays pre-selected: submit keeps it.
    await waitForOutput(started.streams.humanText, "Which Hosts");
    input.write("\r");
    await waitForOutput(started.streams.humanText, "Uninstall as listed?");
    // The chosen mode is visible per Project: removed and kept Hosts named.
    expect(plain(started.streams.humanText())).toContain("remove codex");
    expect(plain(started.streams.humanText())).toContain("keep pi");
    input.write("y\n");
    const result = await started.pending;
    expect(result.exitCode).toBe(0);
    expect(bindingHosts(home, first)).toEqual(["pi"]);
    expect(bindingHosts(home, second)).toEqual(["codex", "pi"]);
    expect(plain(started.streams.humanText())).toContain("--host codex");
  });
  test("a carried unknown Host fails before any pick with zero writes", async () => {
    // The carried filter normalizes before any picker opens: an unknown
    // Host refuses with supported-name guidance instead of proposing.
    const { home, first, second, firstOutput, secondOutput } = await setupInstalledPair();
    const input = fakeInteractiveInput();
    const started = startUninstall(home, ["--host", "bogus"], input);
    const result = await started.pending;
    expect(result.exitCode).toBe(1);
    expect(plain(started.streams.errorText())).toContain("unsupported Agent Host 'bogus'");
    expect(plain(started.streams.humanText())).not.toContain("Which Projects");
    expect(readFileSync(configPath(home), "utf8")).toContain(first);
    expect(readFileSync(configPath(home), "utf8")).toContain(second);
    expect(existsSync(firstOutput)).toBe(true);
    expect(existsSync(secondOutput)).toBe(true);
  });

  test("Host narrowing drops picked Projects with no host intersection without broadening", async () => {
    // The first Project binds codex+pi, the second only codex: picking
    // both, then removing only pi, narrows the first and drops the second
    // — the explicit --host rule — with zero writes to the dropped scope.
    const home = await setupHome();
    const first = projectDirectory();
    const second = projectDirectory();
    await executeInstall(home, { profile: "engineering", hosts: ["codex", "pi"], project: first });
    await executeInstall(home, { profile: "engineering", hosts: ["codex"], project: second });
    const input = fakeInteractiveInput();
    const started = startUninstall(home, [], input);
    await waitForOutput(started.streams.humanText, "Which Projects");
    input.write(" ");
    await settle(150);
    input.write("[B");
    await settle(150);
    input.write(" ");
    await settle(150);
    input.write("\r");
    await waitForOutput(started.streams.humanText, "Whole installations or selected Hosts?");
    input.write("[B");
    await settle(150);
    input.write("\r");
    await waitForOutput(started.streams.humanText, "Which Hosts");
    input.write("pi");
    await waitForOutput(started.streams.humanText, "Filtered results for: pi");
    input.write(" ");
    await settle(150);
    input.write("\r");
    await waitForOutput(started.streams.humanText, "Uninstall as listed?");
    // The review executes only the intersecting Project: slice from the
    // review heading so the picker inventory above cannot satisfy this.
    const review = plain(started.streams.humanText());
    const scope = review.slice(review.lastIndexOf("Uninstall:"));
    expect(scope).toContain(first);
    expect(scope).not.toContain(second);
    input.write("y\n");
    const result = await started.pending;
    expect(result.exitCode).toBe(0);
    expect(bindingHosts(home, first)).toEqual(["codex"]);
    expect(bindingHosts(home, second)).toEqual(["codex"]);
  });
});

describe("interactive picked partial-removal consent", () => {
  async function setupDriftedMultiHostPair(): Promise<{
    readonly home: string;
    readonly drifted: string;
    readonly healthy: string;
    readonly driftedOutput: string;
  }> {
    const home = await setupHome();
    const drifted = projectDirectory();
    const healthy = projectDirectory();
    await executeInstall(home, { profile: "engineering", hosts: ["codex", "pi"], project: drifted });
    await executeInstall(home, { profile: "engineering", hosts: ["codex", "pi"], project: healthy });
    const state = await readInstallationState(home);
    const { realpathSync } = await import("node:fs");
    const receipt = ordinaryReceipts(state).find(
      (entry) => entry.project === realpathSync(drifted),
    );
    const exclusive = receipt?.outputs.find(
      (output) => output.type === "file" && !output.path.startsWith(".agents/skills/"),
    );
    if (receipt === undefined || exclusive === undefined) {
      throw new Error("fixture install produced no exclusive output");
    }
    const driftedOutput = join(drifted, exclusive.path);
    appendFileSync(driftedOutput, "\nIndependent user edit.\n");
    return { home, drifted, healthy, driftedOutput };
  }

  async function pickDriftedHostPartial(
    home: string,
    drifted: string,
    input: PassThrough & { isTTY: true },
    started: StartedUninstall,
  ): Promise<void> {
    await waitForOutput(started.streams.humanText, "Which Projects");
    const driftedSuffix = drifted.slice(-6);
    input.write(driftedSuffix);
    await waitForOutput(started.streams.humanText, `Filtered results for: ${driftedSuffix}`);
    input.write(" ");
    await settle(150);
    input.write("\r");
    await waitForOutput(started.streams.humanText, "Whole installations or selected Hosts?");
    input.write("[B");
    await settle();
    input.write("\r");
    await waitForOutput(started.streams.humanText, "Which Hosts");
    input.write("codex");
    await waitForOutput(started.streams.humanText, "Filtered results for: codex");
    input.write(" ");
    await settle(150);
    input.write("\r");
    await waitForOutput(started.streams.humanText, "Uninstall as listed?");
    input.write("y\n");
  }

  test("accepting picked-partial consent removes and echoes --remove-changed", async () => {
    const { home, drifted, healthy, driftedOutput } = await setupDriftedMultiHostPair();
    const input = fakeInteractiveInput();
    const started = startUninstall(home, [], input);
    await pickDriftedHostPartial(home, drifted, input, started);
    await waitForOutput(started.streams.humanText, plain(APPLY_REPLACEMENT_QUESTION));
    input.write("y\n");
    const result = await started.pending;
    expect(result.exitCode).toBe(0);
    expect(plain(started.streams.humanText())).toContain("--remove-changed");
    expect(bindingHosts(home, drifted)).toEqual(["pi"]);
    expect(existsSync(driftedOutput)).toBe(false);
    expect(bindingHosts(home, healthy)).toEqual(["codex", "pi"]);
  });

  test("declining picked-partial consent leaves everything untouched", async () => {
    const { home, drifted, healthy, driftedOutput } = await setupDriftedMultiHostPair();
    const input = fakeInteractiveInput();
    const started = startUninstall(home, [], input);
    await pickDriftedHostPartial(home, drifted, input, started);
    await waitForOutput(started.streams.humanText, plain(APPLY_REPLACEMENT_QUESTION));
    input.write("n\n");
    const result = await started.pending;
    expect(result.exitCode).toBe(1);
    expect(bindingHosts(home, drifted)).toEqual(["codex", "pi"]);
    expect(existsSync(driftedOutput)).toBe(true);
    expect(readFileSync(driftedOutput, "utf8")).toContain("Independent user edit.");
    expect(bindingHosts(home, healthy)).toEqual(["codex", "pi"]);
  });
});
