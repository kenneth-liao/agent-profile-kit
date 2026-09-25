/**
 * Machine `setupSteps` value pin (spec #672 DEC-004, ticket #701): every
 * Adapter's machine `setupSteps` values stay byte-identical to `171d5d5` —
 * the value set WITHOUT the removed Codex `launch-constraint` step (the
 * recorded narrow DEC-004 exception in ADR-0014's DEC-006 amendment).
 * Human renderings (`humanAction`) live beside each machine message at the
 * step's creation site and never reach machine JSON.
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
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, type Writable } from "node:stream";

import { planAntigravityProject } from "../adapters/antigravity.js";
import { CLAUDE_CONTEXT_RULE_PATH, planClaudeProject } from "../adapters/claude.js";
import { planCodexProject } from "../adapters/codex.js";
import { planGrokProject } from "../adapters/grok.js";
import { planOpenCodeProject } from "../adapters/opencode.js";
import { planPiProject } from "../adapters/pi.js";
import type {
  AdapterHostSetupStep,
  HostSetupStepKind,
  HostSetupProvenance,
} from "../adapters/project-plan.js";
import type { SupportedHost } from "../adapters/host-catalog.js";
import { runInstallCommand } from "../cli/install-command.js";
import { initializeWorkspace } from "../installer/initialize-workspace.js";

/** The machine projection exactly as canonicalMachineSetupSteps emits it. */
function machineSetupStep(host: SupportedHost, step: AdapterHostSetupStep): string {
  const output = step.provenance === "transition" ? step.output : undefined;
  return JSON.stringify({
    host,
    kind: step.kind,
    message: step.message,
    provenance: step.provenance,
    ...(output === undefined ? {} : { output }),
    ...(step.consequence === undefined ? {} : { consequence: step.consequence }),
    ...(step.path === undefined ? {} : { path: step.path }),
  });
}

function machineSetupSteps(host: SupportedHost, steps: readonly AdapterHostSetupStep[]): string[] {
  return steps.map((step) => machineSetupStep(host, step));
}

const MODULES = [{ id: "team-rules", content: "Always preserve the project boundary.\n" }];

const CODEX_STEPS = [
  JSON.stringify({
    host: "codex",
    kind: "approval-required" as HostSetupStepKind,
    message: "Review and approve the generated SessionStart hook when Codex asks.",
    provenance: "transition" as HostSetupProvenance,
    output: ".codex/hooks.json",
    consequence: "Declining the hook prevents Profile Context from loading.",
  }),
  JSON.stringify({
    host: "codex",
    kind: "trust-required" as HostSetupStepKind,
    message: "Trust the bound project in Codex.",
    provenance: "standing" as HostSetupProvenance,
    consequence: "Profile Context does not load until the project is trusted.",
  }),
];

const ANTIGRAVITY_STEPS = [
  JSON.stringify({
    host: "antigravity",
    kind: "trust-required" as HostSetupStepKind,
    message: "Trust the bound project in Antigravity.",
    provenance: "standing" as HostSetupProvenance,
    consequence: "The Profile does not load until the project is trusted.",
  }),
];

const PI_STEPS = [
  JSON.stringify({
    host: "pi",
    kind: "trust-required" as HostSetupStepKind,
    message: "Trust the bound project in Pi.",
    provenance: "standing" as HostSetupProvenance,
    consequence: "The Profile does not load until the project is trusted.",
  }),
];

const OPENCODE_STEPS = [
  JSON.stringify({
    host: "opencode",
    kind: "launch-constraint" as HostSetupStepKind,
    message: "Restart OpenCode to load changed configuration.",
    provenance: "transition" as HostSetupProvenance,
    output: ".opencode/opencode.jsonc",
    consequence:
      "A running OpenCode session keeps its previously loaded configuration until restarted.",
  }),
];

const GROK_SHARED_PATH_STEPS = [
  JSON.stringify({
    host: "grok",
    kind: "shared-path" as HostSetupStepKind,
    message: `Grok uses Profile Context from Claude's shared rule path: ${CLAUDE_CONTEXT_RULE_PATH}.`,
    provenance: "standing" as HostSetupProvenance,
  }),
];

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
    const home = mkdtempSync(join(tmpdir(), "agent-profile-kit-setup-steps-pin-"));
    const project = mkdtempSync(join(tmpdir(), "agent-profile-kit-setup-steps-project-"));
    const bin = mkdtempSync(join(tmpdir(), "agent-profile-kit-setup-steps-hosts-"));
    try {
      writeFileSync(join(bin, "codex"), "#!/bin/sh\necho \"codex-cli 0.145.0\"\n", { mode: 0o755 });
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
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
      rmSync(bin, { recursive: true, force: true });
    }
  });
});
