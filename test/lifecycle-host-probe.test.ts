import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initializeWorkspace } from "../installer/initialize-workspace.js";
import { statusApplication } from "../installer/commands.js";
import {
  buildDesiredState,
  type LifecyclePlanningInstrumentation,
} from "../installer/project-plan.js";
import { reportBlockers } from "./support/reconciliation-report.js";

const temporaryDirectories: string[] = [];

afterAll(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function emptyInstrumentation(): LifecyclePlanningInstrumentation & {
  readonly counts: { probeHostCapability: number };
} {
  const counts = { probeHostCapability: 0 };
  return {
    counts,
    onProbeHostCapability: () => {
      counts.probeHostCapability += 1;
    },
  };
}

function writeSkill(
  workspace: string,
  id: string,
  modelInvocation: "allowed" | "disabled",
): void {
  const skillRoot = join(workspace, "skills", id);
  mkdirSync(skillRoot, { recursive: true });
  const invocation =
    modelInvocation === "disabled"
      ? "metadata:\n  agent-profile-kit.model-invocation: disabled\n"
      : "";
  writeFileSync(
    join(skillRoot, "SKILL.md"),
    `---\nname: ${id}\ndescription: Skill ${id}.\n${invocation}---\n\n# ${id}\n`,
  );
}

/**
 * One shared Workspace with three Profiles that exercise distinct machine-level
 * Host capability requirement sets:
 * - context-only: Context (requireContext), no Skills.
 * - skills-only: Skills with allowed invocation (requireSkills), no Context.
 * - skills-disabled: Skills with disabled invocation (requireDisabledModelInvocation).
 */
async function fleetWorkspace(options: {
  readonly home: string;
  readonly bindings: readonly {
    readonly hosts: readonly string[];
    readonly profile: string;
  }[];
}): Promise<readonly string[]> {
  await initializeWorkspace(options.home);
  mkdirSync(join(options.home, ".codex"), { recursive: true });
  writeFileSync(join(options.home, ".codex", "config.toml"), "[features]\nhooks = true\n");
  const application = join(options.home, ".agents", "agent-profile-kit");
  const workspace = join(application, "workspace");
  writeFileSync(
    join(workspace, "context", "team-rules.md"),
    "---\nid: team-rules\ndependencies: []\n---\nAlways preserve the project boundary.\n",
  );
  writeSkill(workspace, "review-pr", "allowed");
  writeSkill(workspace, "ops-run", "disabled");
  writeFileSync(
    join(workspace, "profiles", "context-only.yaml"),
    "id: context-only\ncontext: [team-rules]\nskills: []\n",
  );
  writeFileSync(
    join(workspace, "profiles", "skills-only.yaml"),
    "id: skills-only\ncontext: []\nskills: [review-pr]\n",
  );
  writeFileSync(
    join(workspace, "profiles", "skills-disabled.yaml"),
    "id: skills-disabled\ncontext: []\nskills: [ops-run]\n",
  );
  const projects: string[] = [];
  const bindingLines = options.bindings.map((binding) => {
    const project = temporaryDirectory("apk-host-probe-project-");
    projects.push(project);
    return (
      `  - project: ${project}\n    profile: ${binding.profile}\n` +
      `    hosts: [${binding.hosts.join(", ")}]\n`
    );
  });
  writeFileSync(
    join(application, "config.yaml"),
    `schema_version: 2\nworkspace: ${workspace}\nbindings:\n${bindingLines.join("")}`,
  );
  return projects;
}

function grokInspectBody(version: string): string {
  return JSON.stringify({
    externalCompat: {
      cells: [
        { enabled: true, source: "default", surface: "rules", vendor: "claude" },
      ],
      remoteSettingsLoaded: false,
    },
    grokVersion: version,
    projectInstructions: [],
    skills: [],
  });
}

/**
 * Install fake Host executables that append every invocation to a shared probe
 * log, so probe counts are objective executable launches rather than inferred
 * from instrumentation alone. Returns the bin directory.
 */
function installProbeHosts(
  home: string,
  versions: {
    readonly antigravity?: string;
    readonly claude?: string;
    readonly codex?: string;
    readonly grok?: string;
    readonly pi?: string;
  },
): string {
  const bin = join(home, "bin");
  mkdirSync(bin, { recursive: true });
  const log = join(home, "probe.log");
  const record = (name: string): string =>
    `printf '%s: %s\\n' '${name}' "$*" >> '${log}'\n`;
  const executables: string[] = [];
  if (versions.antigravity !== undefined) {
    const path = join(bin, "agy");
    writeFileSync(
      path,
      `#!/bin/sh\n${record("antigravity")}echo "agy ${versions.antigravity}"\n`,
    );
    executables.push(path);
  }
  if (versions.codex !== undefined) {
    const path = join(bin, "codex");
    writeFileSync(
      path,
      `#!/bin/sh\n${record("codex")}echo "codex-cli ${versions.codex}"\n`,
    );
    executables.push(path);
  }
  if (versions.claude !== undefined) {
    const path = join(bin, "claude");
    writeFileSync(
      path,
      `#!/bin/sh\n${record("claude")}echo "${versions.claude} (Claude Code)"\n`,
    );
    executables.push(path);
  }
  if (versions.grok !== undefined) {
    const path = join(bin, "grok");
    writeFileSync(
      path,
      `#!/bin/sh\n${record("grok")}if [ "$1" = "version" ]; then\n` +
        `  echo "grok ${versions.grok} (fake) [stable]"\n  exit 0\nfi\n` +
        `if [ "$1" = "inspect" ] && [ "$2" = "--json" ]; then\n` +
        `  cat <<'EOF'\n${grokInspectBody(versions.grok)}\nEOF\n  exit 0\nfi\n` +
        `echo "unexpected grok invocation: $*" >&2\nexit 2\n`,
    );
    executables.push(path);
  }
  if (versions.pi !== undefined) {
    const path = join(bin, "pi");
    writeFileSync(
      path,
      `#!/bin/sh\n${record("pi")}echo "pi ${versions.pi}"\n`,
    );
    executables.push(path);
  }
  for (const executable of executables) chmodSync(executable, 0o755);
  return bin;
}

function readProbeLog(home: string): readonly string[] {
  const log = join(home, "probe.log");
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.length > 0);
}

describe("machine-level Host capability probes within one invocation", () => {
  test("probes one unique machine-level Host requirement set once across many Projects", async () => {
    const home = temporaryDirectory("apk-host-probe-once-");
    await fleetWorkspace({
      home,
      bindings: [
        { hosts: ["codex"], profile: "context-only" },
        { hosts: ["codex"], profile: "context-only" },
        { hosts: ["codex"], profile: "context-only" },
        { hosts: ["codex"], profile: "context-only" },
      ],
    });
    const bin = installProbeHosts(home, { codex: "0.145.0" });
    const instrumentation = emptyInstrumentation();

    const desired = await buildDesiredState(home, {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
      planningInstrumentation: instrumentation,
    });

    expect(desired.installations).toHaveLength(4);
    expect(instrumentation.counts.probeHostCapability).toBe(1);
    expect(readProbeLog(home)).toEqual(["codex: --version"]);
    for (const installation of desired.installations) {
      expect(installation.capabilityWarnings).toEqual([]);
    }
  });

  test("distinct Host requirement sets probe independently and cannot reuse incompatible evidence", async () => {
    const home = temporaryDirectory("apk-host-probe-distinct-");
    await fleetWorkspace({
      home,
      bindings: [
        { hosts: ["codex"], profile: "context-only" },
        { hosts: ["codex"], profile: "context-only" },
        { hosts: ["codex"], profile: "skills-disabled" },
      ],
    });
    // 0.100.0 meets the disabled-invocation floor (0.99.0) but not complete
    // Context (0.145.0), so the two requirement sets cannot share evidence.
    const bin = installProbeHosts(home, { codex: "0.100.0" });
    const instrumentation = emptyInstrumentation();

    const desired = await buildDesiredState(home, {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
      planningInstrumentation: instrumentation,
    });

    expect(desired.installations).toHaveLength(3);
    expect(instrumentation.counts.probeHostCapability).toBe(2);
    expect(readProbeLog(home)).toEqual([
      "codex: --version",
      "codex: --version",
    ]);
    const contextInstallations = desired.installations.filter(
      (installation) => installation.binding.profile === "context-only",
    );
    expect(contextInstallations).toHaveLength(2);
    // Identical cached probe failures deduplicate to one warning per invocation.
    expect(contextInstallations[0]?.capabilityWarnings).toHaveLength(1);
    expect(contextInstallations[0]?.capabilityWarnings[0]?.warning.message).toContain(
      "cannot deliver complete Context",
    );
    expect(contextInstallations[1]?.capabilityWarnings).toEqual([]);
    // The disabled-invocation Project must not reuse the incompatible failure.
    const disabledInstallation = desired.installations.find(
      (installation) => installation.binding.profile === "skills-disabled",
    );
    expect(disabledInstallation?.capabilityWarnings).toEqual([]);
  });

  test("an outdated Host emits one warning per Host per invocation across distinct requirement sets", async () => {
    const home = temporaryDirectory("apk-host-probe-outdated-");
    await fleetWorkspace({
      home,
      bindings: [
        { hosts: ["claude"], profile: "context-only" },
        { hosts: ["claude"], profile: "context-only" },
        { hosts: ["claude"], profile: "skills-disabled" },
      ],
    });
    // 2.0.63 is below the 2.0.64 floor, so the context-only requirement set
    // fails with the unscoped-rules message and the skills-disabled set fails
    // with the disabled-invocation message: two distinct requirement messages
    // from the same Host in one invocation.
    const bin = installProbeHosts(home, { claude: "2.0.63" });

    const desired = await buildDesiredState(home, {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
    });

    expect(desired.installations).toHaveLength(3);
    const claudeWarnings = desired.installations.flatMap((installation) =>
      installation.capabilityWarnings.filter((entry) => entry.host === "claude"),
    );
    // One warning per Host per invocation (DEC-014), regardless of how many
    // distinct requirement messages the Host produced.
    expect(claudeWarnings).toHaveLength(1);
    expect(claudeWarnings[0]?.warning.message).toContain("requires 2.0.64+");
  });

  test("Project-specific destination checks still run for every affected Project", async () => {
    const home = temporaryDirectory("apk-host-probe-surface-");
    const projects = await fleetWorkspace({
      home,
      bindings: [
        { hosts: ["pi"], profile: "skills-only" },
        { hosts: ["pi"], profile: "skills-only" },
      ],
    });
    writeFileSync(join(projects[1]!, ".agents"), "not a directory\n");
    const bin = installProbeHosts(home, { pi: "0.82.1" });
    const instrumentation = emptyInstrumentation();

    const desired = await buildDesiredState(home, {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
      planningInstrumentation: instrumentation,
    });

    expect(instrumentation.counts.probeHostCapability).toBe(1);
    expect(readProbeLog(home)).toEqual(["pi: --version"]);
    // Installations are sorted by canonical Project path, not fixture creation
    // order, so match each installation to its fixture Project explicitly.
    const byProject = new Map(
      desired.installations.map((installation) => [
        installation.binding.canonicalProject,
        installation,
      ]),
    );
    const obstructed = byProject.get(realpathSync(projects[1]!));
    const clean = byProject.get(realpathSync(projects[0]!));
    expect(clean?.capabilityWarnings).toEqual([]);
    // Project-surface evidence is Project-specific, so it stays on its own Project.
    expect(obstructed?.capabilityWarnings).toHaveLength(1);
    expect(obstructed?.capabilityWarnings[0]?.warning.message).toContain(
      "Pi shared project surface cannot host Skills",
    );
  });

  test("host-scope dedup keeps the strictest required version across mixed floors", async () => {
    const home = temporaryDirectory("apk-host-probe-mixed-floor-");
    await initializeWorkspace(home);
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex", "config.toml"), "[features]\nhooks = true\n");
    const application = join(home, ".agents", "agent-profile-kit");
    const workspace = join(application, "workspace");
    writeFileSync(
      join(workspace, "context", "team-rules.md"),
      "---\nid: team-rules\ndependencies: []\n---\nAlways preserve the project boundary.\n",
    );
    writeSkill(workspace, "ops-run", "disabled");
    writeFileSync(
      join(workspace, "profiles", "context-only.yaml"),
      "id: context-only\ncontext: [team-rules]\nskills: []\n",
    );
    writeFileSync(
      join(workspace, "profiles", "skills-disabled.yaml"),
      "id: skills-disabled\ncontext: []\nskills: [ops-run]\n",
    );
    // Projects under the HOME keep canonical order deterministic: the 0.99.0
    // floor (disabled invocation) sorts first, the 0.145.0 floor (Context) second.
    const skillsProject = join(home, "fleet", "a-skills");
    const contextProject = join(home, "fleet", "b-context");
    mkdirSync(skillsProject, { recursive: true });
    mkdirSync(contextProject, { recursive: true });
    writeFileSync(
      join(application, "config.yaml"),
      `schema_version: 2\nworkspace: ${workspace}\nbindings:\n` +
        `  - project: ${skillsProject}\n    profile: skills-disabled\n    hosts: [codex]\n` +
        `  - project: ${contextProject}\n    profile: context-only\n    hosts: [codex]\n`,
    );
    // 0.98.0 misses both floors, so each requirement set fails with its own
    // floor message: 0.99.0+ first in canonical order, 0.145.0+ second.
    const bin = installProbeHosts(home, { codex: "0.98.0" });
    const instrumentation = emptyInstrumentation();

    const desired = await buildDesiredState(home, {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
      planningInstrumentation: instrumentation,
    });

    expect(desired.installations).toHaveLength(2);
    expect(instrumentation.counts.probeHostCapability).toBe(2);
    const codexWarnings = desired.installations.flatMap((installation) =>
      installation.capabilityWarnings.filter((entry) => entry.host === "codex"),
    );
    // One warning per Host per invocation, and it names the strictest floor:
    // the surviving 0.145.0+ warning is sufficient guidance for every Project,
    // while the first-in-order 0.99.0+ warning alone would not be.
    expect(codexWarnings).toHaveLength(1);
    expect(codexWarnings[0]?.warning.message).toContain("requires 0.145.0+");
    expect(codexWarnings[0]?.warning.message).not.toContain("0.99.0");
  });

  test("Project-specific Grok inspection failures stay distinct across Projects", async () => {
    const home = temporaryDirectory("apk-host-probe-grok-inspect-");
    await fleetWorkspace({
      home,
      bindings: [
        { hosts: ["grok"], profile: "context-only" },
        { hosts: ["grok"], profile: "context-only" },
      ],
    });
    // The version probe succeeds but per-Project `grok inspect --json` fails in
    // every bound Project: the failure evidence is Project-specific even though
    // it carries no path affected item.
    const bin = join(home, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      join(bin, "grok"),
      '#!/bin/sh\nif [ "$1" = "version" ]; then\n  echo "grok 0.2.111 (fake) [stable]"\n  exit 0\nfi\nexit 3\n',
    );
    chmodSync(join(bin, "grok"), 0o755);

    const desired = await buildDesiredState(home, {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
    });

    expect(desired.installations).toHaveLength(2);
    // One distinct warning per affected Project, not one collapsed Host warning.
    const warned = desired.installations.filter(
      (installation) => installation.capabilityWarnings.length > 0,
    );
    expect(warned).toHaveLength(2);
    for (const installation of warned) {
      expect(installation.capabilityWarnings[0]?.host).toBe("grok");
      expect(installation.capabilityWarnings[0]?.warning.message).toContain(
        "Grok project inspection failed",
      );
    }
  });

  test("Grok topology inspection stays Project-specific while the version probe runs once", async () => {
    const home = temporaryDirectory("apk-host-probe-grok-topology-");
    await fleetWorkspace({
      home,
      bindings: [
        { hosts: ["grok"], profile: "context-only" },
        { hosts: ["grok"], profile: "context-only" },
      ],
    });
    const bin = installProbeHosts(home, { grok: "0.2.111" });
    const instrumentation = emptyInstrumentation();

    const desired = await buildDesiredState(home, {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
      planningInstrumentation: instrumentation,
    });

    expect(instrumentation.counts.probeHostCapability).toBe(1);
    expect(readProbeLog(home)).toEqual([
      "grok: version",
      "grok: inspect --json",
      "grok: inspect --json",
    ]);
    for (const installation of desired.installations) {
      expect(installation.capabilityWarnings).toEqual([]);
    }
  });

  test("missing, outdated, malformed, and supported Host results keep identical blocker semantics", async () => {
    const scenarios: readonly {
      readonly expected: string;
      readonly name: string;
      readonly writeCodexStub: (bin: string) => void;
    }[] = [
      {
        expected: "Codex CLI was not found on PATH",
        name: "missing",
        writeCodexStub: () => {},
      },
      {
        expected: "cannot deliver complete Context through SessionStart hooks (requires 0.145.0+)",
        name: "outdated",
        writeCodexStub: (bin) => {
          writeFileSync(
            join(bin, "codex"),
            "#!/bin/sh\necho 'codex-cli 0.144.6'\n",
          );
        },
      },
      {
        expected: "Codex CLI version is unreadable",
        name: "malformed",
        writeCodexStub: (bin) => {
          writeFileSync(
            join(bin, "codex"),
            "#!/bin/sh\necho 'not a version'\n",
          );
        },
      },
      {
        expected: "",
        name: "supported",
        writeCodexStub: (bin) => {
          writeFileSync(
            join(bin, "codex"),
            "#!/bin/sh\necho 'codex-cli 0.145.0'\n",
          );
        },
      },
    ];

    for (const scenario of scenarios) {
      const home = temporaryDirectory(`apk-host-probe-${scenario.name}-`);
      await fleetWorkspace({
        home,
        bindings: [
          { hosts: ["codex"], profile: "context-only" },
          { hosts: ["codex"], profile: "context-only" },
        ],
      });
      const bin = join(home, "bin");
      mkdirSync(bin, { recursive: true });
      scenario.writeCodexStub(bin);
      const codexStub = join(bin, "codex");
      if (existsSync(codexStub)) chmodSync(codexStub, 0o755);
      const instrumentation = emptyInstrumentation();

      const desired = await buildDesiredState(home, {
        // The missing scenario keeps PATH hermetic so the probe cannot find an
        // ambient Host executable; the others resolve the controlled stub first.
        env: {
          ...process.env,
          PATH:
            scenario.name === "missing"
              ? bin
              : `${bin}:${process.env.PATH ?? ""}`,
        },
        planningInstrumentation: instrumentation,
      });

      expect(instrumentation.counts.probeHostCapability).toBe(1);
      expect(desired.installations).toHaveLength(2);
      for (const installation of desired.installations) {
        if (scenario.expected === "") {
          expect(installation.capabilityWarnings).toEqual([]);
        } else if (installation === desired.installations[0]) {
          expect(installation.capabilityWarnings).toHaveLength(1);
          expect(installation.capabilityWarnings[0]?.warning.message).toContain(scenario.expected);
        } else {
          // The identical missing/outdated/malformed failure warns once per invocation.
          expect(installation.capabilityWarnings).toEqual([]);
        }
      }
    }
  });

  test("probe evidence is discarded at command exit and a later invocation probes again", async () => {
    const home = temporaryDirectory("apk-host-probe-invocation-");
    await fleetWorkspace({
      home,
      bindings: [
        { hosts: ["codex"], profile: "context-only" },
        { hosts: ["codex"], profile: "context-only" },
      ],
    });
    const bin = installProbeHosts(home, { codex: "0.145.0" });
    const first = emptyInstrumentation();
    const second = emptyInstrumentation();

    await buildDesiredState(home, {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
      planningInstrumentation: first,
    });
    await buildDesiredState(home, {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
      planningInstrumentation: second,
    });

    expect(first.counts.probeHostCapability).toBe(1);
    expect(second.counts.probeHostCapability).toBe(1);
    expect(readProbeLog(home)).toEqual([
      "codex: --version",
      "codex: --version",
    ]);
  });

  test("every supported Host machine probe runs once in one fleet invocation", async () => {
    const home = temporaryDirectory("apk-host-probe-fleet-");
    await fleetWorkspace({
      home,
      bindings: [
        { hosts: ["antigravity"], profile: "context-only" },
        { hosts: ["codex"], profile: "context-only" },
        { hosts: ["claude"], profile: "context-only" },
        { hosts: ["grok"], profile: "context-only" },
        { hosts: ["pi"], profile: "context-only" },
      ],
    });
    const bin = installProbeHosts(home, {
      antigravity: "1.1.13",
      claude: "2.0.64",
      codex: "0.145.0",
      grok: "0.2.111",
      pi: "0.82.1",
    });
    const instrumentation = emptyInstrumentation();

    const desired = await buildDesiredState(home, {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
      planningInstrumentation: instrumentation,
    });

    expect(desired.installations).toHaveLength(5);
    expect(instrumentation.counts.probeHostCapability).toBe(5);
    const counts = { antigravity: 0, claude: 0, codex: 0, "grok-inspect": 0, "grok-version": 0, pi: 0 };
    for (const line of readProbeLog(home)) {
      if (line === "antigravity: --version") counts.antigravity += 1;
      else if (line === "codex: --version") counts.codex += 1;
      else if (line === "claude: --version") counts.claude += 1;
      else if (line === "grok: version") counts["grok-version"] += 1;
      else if (line === "grok: inspect --json") counts["grok-inspect"] += 1;
      else if (line === "pi: --version") counts.pi += 1;
      else throw new Error(`unexpected probe invocation '${line}'`);
    }
    expect(counts).toEqual({
      antigravity: 1,
      claude: 1,
      codex: 1,
      "grok-inspect": 1,
      "grok-version": 1,
      pi: 1,
    });
    for (const installation of desired.installations) {
      expect(installation.capabilityWarnings).toEqual([]);
    }
  });

  test("status performs no Agent Host process execution and reports Projects without capability blockers", async () => {
    const home = temporaryDirectory("apk-host-probe-status-");
    await fleetWorkspace({
      home,
      bindings: [
        { hosts: ["codex"], profile: "context-only" },
        { hosts: ["codex"], profile: "context-only" },
      ],
    });
    // Controlled Hosts are on PATH and recording; status must not launch them.
    const bin = installProbeHosts(home, { codex: "0.145.0" });

    const report = await statusApplication(home, {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
    });

    expect(report.projects).toHaveLength(2);
    expect(reportBlockers(report)).toEqual([]);
    for (const project of report.projects) {
      expect(project.blockers).toEqual([]);
      expect(project.warnings).toEqual([]);
    }
    expect(readProbeLog(home)).toEqual([]);
  });
});
