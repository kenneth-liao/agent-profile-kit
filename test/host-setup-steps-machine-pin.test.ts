/**
 * Machine `setupSteps` value pin (spec #672 DEC-004, ticket #701): every
 * Adapter's machine `setupSteps` values stay byte-identical to `171d5d5` —
 * the value set WITHOUT the removed Codex `launch-constraint` step (the
 * recorded narrow DEC-004 exception in ADR-0014's DEC-006 amendment).
 * Human renderings (`humanAction`) live beside each machine message at the
 * step's creation site and never reach machine JSON.
 *
 * The adapter half projects through the production projector
 * (`canonicalMachineSetupSteps`), so a wholesale-spread regression fails here
 * and not only in the journeys, and every entry's exact machine key set is
 * asserted. Two journeys then pin the two DEC-004 serialization sites
 * end-to-end: `install --json` (lifecycle payloads) and
 * `machine install-temp --json` (temporary-installation payloads).
 *
 * Serialization sites checked; the step object is never serialized wholesale:
 * - lifecycle JSON (`status`/`update`/`install`/`uninstall` `--json`):
 *   `canonicalMachineSetupSteps` (cli/presentation.ts) picks
 *   host/kind/message/provenance/output/consequence/path explicitly
 * - `machine install-temp --json`: `temporarySetupStepJson` (cli/presentation.ts)
 *   picks the same fields explicitly
 * - operation history (`installer/operation-history.ts`) and
 *   `apkit details --json`: entries carry no setupSteps
 * - installation records (`schemas/ownership-state.ts` OwnershipReceipt):
 *   no setupSteps
 * - lifecycle transactions (install/uninstall/temporary-installation commit
 *   paths): no setupSteps
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough, type Writable } from "node:stream";
import { fileURLToPath } from "node:url";

import { planAntigravityProject } from "../adapters/antigravity.js";
import { CLAUDE_CONTEXT_RULE_PATH, planClaudeProject } from "../adapters/claude.js";
import { planCodexProject } from "../adapters/codex.js";
import { planGrokProject } from "../adapters/grok.js";
import { planOpenCodeProject } from "../adapters/opencode.js";
import { planPiProject } from "../adapters/pi.js";
import type { AdapterHostSetupStep } from "../adapters/project-plan.js";
import type { SupportedHost } from "../adapters/host-catalog.js";
import { canonicalMachineSetupSteps } from "../cli/presentation.js";
import { runInstallCommand } from "../cli/install-command.js";
import { initializeWorkspace } from "../installer/initialize-workspace.js";
import type { ReconciliationProjectRecord } from "../installer/reconcile.js";
import {
  TEST_CHILD_DEADLINE_MS,
  runProcess,
} from "../process/process-executor.js";
import {
  extractPackageArchive,
  obtainPackageArchive,
  packedCliNodeExecutable,
} from "./support/package-archive.js";
import {
  controlledEnvironment,
  controlledPath,
} from "./support/controlled-environment.js";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const temporaryDirectories: string[] = [];
let packageArchiveCleanup = (): void => undefined;
let cliPath = "";

beforeAll(async () => {
  const archive = await obtainPackageArchive(repositoryRoot, "agent-profile-kit-pin-pack-");
  packageArchiveCleanup = archive.cleanup;
  const extracted = mkdtempSync(join(tmpdir(), "agent-profile-kit-pin-packed-"));
  temporaryDirectories.push(extracted);
  await extractPackageArchive(archive.path, extracted);
  cliPath = join(extracted, "package", "dist", "cli.js");
});

afterAll(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
  packageArchiveCleanup();
});

/** The machine projection exactly as the production projector emits it. */
function machineSetupSteps(host: SupportedHost, steps: readonly AdapterHostSetupStep[]): string[] {
  const projected = canonicalMachineSetupSteps({
    project: "/project-a",
    setupSteps: steps.map((step) => ({ ...step, host })),
  } as unknown as ReconciliationProjectRecord);
  return projected.map((step) => JSON.stringify(step));
}

/** Assert the exact machine key set (order included) of projected entries. */
function machineKeySets(serialized: readonly string[]): string[][] {
  return serialized.map((entry) => Object.keys(JSON.parse(entry) as object));
}

const MODULES = [{ id: "team-rules", content: "Always preserve the project boundary.\n" }];

const CODEX_STEPS = [
  JSON.stringify({
    host: "codex",
    kind: "approval-required",
    message: "Review and approve the generated SessionStart hook when Codex asks.",
    provenance: "transition",
    output: ".codex/hooks.json",
    consequence: "Declining the hook prevents Profile Context from loading.",
  }),
  JSON.stringify({
    host: "codex",
    kind: "trust-required",
    message: "Trust the bound project in Codex.",
    provenance: "standing",
    consequence: "Profile Context does not load until the project is trusted.",
  }),
];

const ANTIGRAVITY_STEPS = [
  JSON.stringify({
    host: "antigravity",
    kind: "trust-required",
    message: "Trust the bound project in Antigravity.",
    provenance: "standing",
    consequence: "The Profile does not load until the project is trusted.",
  }),
];

const PI_STEPS = [
  JSON.stringify({
    host: "pi",
    kind: "trust-required",
    message: "Trust the bound project in Pi.",
    provenance: "standing",
    consequence: "The Profile does not load until the project is trusted.",
  }),
];

const OPENCODE_STEPS = [
  JSON.stringify({
    host: "opencode",
    kind: "launch-constraint",
    message: "Restart OpenCode to load changed configuration.",
    provenance: "transition",
    output: ".opencode/opencode.jsonc",
    consequence:
      "A running OpenCode session keeps its previously loaded configuration until restarted.",
  }),
];

const GROK_SHARED_PATH_STEPS = [
  JSON.stringify({
    host: "grok",
    kind: "shared-path",
    message: `Grok uses Profile Context from Claude's shared rule path: ${CLAUDE_CONTEXT_RULE_PATH}.`,
    provenance: "standing",
  }),
];

/** One isolated home with a context-bearing `coding` Profile and a Codex stub. */
function prepareCodexFixture(): {
  readonly bin: string;
  readonly home: string;
  readonly project: string;
} {
  const home = mkdtempSync(join(tmpdir(), "agent-profile-kit-setup-steps-pin-"));
  const project = mkdtempSync(join(tmpdir(), "agent-profile-kit-setup-steps-project-"));
  const bin = mkdtempSync(join(tmpdir(), "agent-profile-kit-setup-steps-hosts-"));
  temporaryDirectories.push(home, project, bin);
  writeFileSync(join(bin, "codex"), "#!/bin/sh\necho \"codex-cli 0.145.0\"\n", { mode: 0o755 });
  return { bin, home, project };
}

async function writeCodexWorkspace(home: string): Promise<void> {
  await initializeWorkspace(home, { workspace: "~/apkit-workspace" });
  mkdirSync(join(home, "apkit-workspace", "context"), { recursive: true });
  writeFileSync(
    join(home, "apkit-workspace", "context", "team-rules.md"),
    "Always preserve the project boundary.\n",
  );
  mkdirSync(join(home, "apkit-workspace", "profiles"), { recursive: true });
  writeFileSync(
    join(home, "apkit-workspace", "profiles", "coding.yaml"),
    "context:\n  - team-rules\nskills: []\n",
  );
  mkdirSync(join(home, ".agents", "agent-profile-kit"), { recursive: true });
  writeFileSync(
    join(home, ".agents", "agent-profile-kit", "config.yaml"),
    "schema_version: 2\nworkspace: ~/apkit-workspace\nbindings: []\n",
  );
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(join(home, ".codex", "config.toml"), "[features]\nhooks = true\n");
}

describe("machine setupSteps values stay byte-identical to 171d5d5 (DEC-004 pin)", () => {
  test("every Adapter's machine setupSteps values match the frozen value set", async () => {
    const codex = await planCodexProject("coding", MODULES);
    expect(machineSetupSteps("codex", codex.setupSteps)).toEqual(CODEX_STEPS);

    const codexSkillsOnly = await planCodexProject("coding", []);
    expect(machineSetupSteps("codex", codexSkillsOnly.setupSteps)).toEqual([]);

    const antigravity = await planAntigravityProject("coding", MODULES, []);
    expect(machineSetupSteps("antigravity", antigravity.setupSteps)).toEqual(ANTIGRAVITY_STEPS);

    const pi = await planPiProject("coding", MODULES);
    expect(machineSetupSteps("pi", pi.setupSteps)).toEqual(PI_STEPS);

    const opencode = await planOpenCodeProject("coding", MODULES);
    expect(machineSetupSteps("opencode", opencode.setupSteps)).toEqual(OPENCODE_STEPS);

    const opencodeSkillsOnly = await planOpenCodeProject("coding", []);
    expect(machineSetupSteps("opencode", opencodeSkillsOnly.setupSteps)).toEqual([]);

    const grokShared = await planGrokProject("coding", MODULES, [], {
      claudeCoSelected: true,
      claudeRulesEnabled: true,
    });
    expect(machineSetupSteps("grok", grokShared.setupSteps)).toEqual(GROK_SHARED_PATH_STEPS);

    const grokOwnPath = await planGrokProject("coding", MODULES);
    expect(machineSetupSteps("grok", grokOwnPath.setupSteps)).toEqual([]);

    const claude = await planClaudeProject("coding", MODULES);
    expect(machineSetupSteps("claude", claude.setupSteps)).toEqual([]);

    // The exact machine key set, asserted once per pinned value set, so a
    // wholesale-spread regression in the projector fails here (INT-3).
    for (const [host, steps, frozen] of [
      ["codex", codex.setupSteps, CODEX_STEPS],
      ["antigravity", antigravity.setupSteps, ANTIGRAVITY_STEPS],
      ["pi", pi.setupSteps, PI_STEPS],
      ["opencode", opencode.setupSteps, OPENCODE_STEPS],
      ["grok", grokShared.setupSteps, GROK_SHARED_PATH_STEPS],
    ] as const) {
      expect(machineKeySets(machineSetupSteps(host, steps))).toEqual(machineKeySets(frozen));
    }

    // The removed Codex `launch-constraint` value stays removed (the recorded
    // DEC-004 exception): the only `launch-constraint` value is OpenCode's
    // restart step, and no human rendering is a machine value.
    const allMachineValues = [
      ...machineSetupSteps("codex", codex.setupSteps),
      ...machineSetupSteps("antigravity", antigravity.setupSteps),
      ...machineSetupSteps("pi", pi.setupSteps),
      ...machineSetupSteps("opencode", opencode.setupSteps),
      ...machineSetupSteps("grok", grokShared.setupSteps),
    ];
    expect(allMachineValues.filter((value) => value.includes("launch-constraint"))).toEqual(
      OPENCODE_STEPS,
    );
    expect(allMachineValues.some((value) => value.includes("bound project root"))).toBe(false);
    expect(allMachineValues.some((value) => value.includes("humanAction"))).toBe(false);
  });

  test("install --json publishes setupSteps with exactly the machine fields (no human rendering)", async () => {
    const { bin, home, project } = prepareCodexFixture();
    await writeCodexWorkspace(home);
    const chunks: Buffer[] = [];
    const stdout = new PassThrough();
    stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    const outcome = await runInstallCommand({
      home,
      arguments: ["coding", project, "--agent", "codex", "--auto-confirm", "--json"],
      stdout: stdout as Writable & { isTTY?: boolean },
      stderr: new PassThrough() as Writable & { isTTY?: boolean },
      input: new PassThrough(),
      env: { PATH: bin },
    });
    expect(outcome.exitCode).toBe(0);

    const payload = JSON.parse(Buffer.concat(chunks).toString()) as {
      projects?: readonly { setupSteps?: readonly unknown[] }[];
      applied?: { projects?: readonly { setupSteps?: readonly unknown[] }[] };
    };
    const serialized = (steps: readonly unknown[] | undefined): string[] =>
      (steps ?? []).map((step) => JSON.stringify(step));
    expect(serialized(payload.projects?.[0]?.setupSteps)).toEqual(CODEX_STEPS);
    expect(serialized(payload.applied?.projects?.[0]?.setupSteps)).toEqual(CODEX_STEPS);
    expect(machineKeySets(serialized(payload.projects?.[0]?.setupSteps))).toEqual(
      machineKeySets(CODEX_STEPS),
    );
  });

  test("machine install-temp --json publishes setupSteps byte-equal to the pinned values", async () => {
    const { bin, home, project } = prepareCodexFixture();
    await writeCodexWorkspace(home);
    const result = await runProcess({
      executable: packedCliNodeExecutable(),
      arguments_: [
        cliPath,
        "machine", "install-temp",
        "coding",
        project,
        "--host", "codex",
        "--json",
      ],
      environment: controlledEnvironment({
        home,
        path: `${bin}:${controlledPath(home)}`,
      }),
      deadlineMs: TEST_CHILD_DEADLINE_MS,
      commandLabel: "packed CLI",
    });
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      readonly setupSteps?: readonly unknown[];
    };
    const serialized = (payload.setupSteps ?? []).map((step) => JSON.stringify(step));
    expect(serialized).toEqual(CODEX_STEPS);
    expect(machineKeySets(serialized)).toEqual(machineKeySets(CODEX_STEPS));
  });
});
