import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_ADAPTER_PLANNING_MATERIALS } from "../adapters/skill-package.js";

import {
  HOST_REGISTRY,
  SUPPORTED_HOSTS,
  adapterVersionFor,
  detectInstalledHosts,
  hostRegistrationFor,
  isSupportedHost,
} from "../adapters/registry.js";
import { listHosts } from "../installer/inventory.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

describe("canonical Host registry", () => {
  test("owns supported Host order, lookup, Adapter versions, temporary eligibility, and inventory metadata", () => {
    expect(SUPPORTED_HOSTS).toEqual([
      "antigravity",
      "claude",
      "codex",
      "grok",
      "opencode",
      "pi",
    ]);
    expect(HOST_REGISTRY.map((registration) => registration.host)).toEqual([...SUPPORTED_HOSTS]);
    expect(isSupportedHost("claude")).toBe(true);
    expect(isSupportedHost("opencode")).toBe(true);
    expect(isSupportedHost("unknown")).toBe(false);
    expect(hostRegistrationFor("claude")).toMatchObject({
      adapterVersion: "claude-project-v1",
      host: "claude",
      supportsTemporaryProfileInstallation: true,
    });
    expect(hostRegistrationFor("opencode")).toMatchObject({
      adapterVersion: "opencode-project-v1",
      host: "opencode",
      supportsTemporaryProfileInstallation: true,
    });
    expect(hostRegistrationFor("pi")).toMatchObject({
      adapterVersion: "pi-project-v2",
      host: "pi",
      supportsTemporaryProfileInstallation: true,
    });
    expect(() => hostRegistrationFor("unknown" as "claude")).toThrow(
      "Unsupported Agent Host 'unknown'",
    );

    expect(adapterVersionFor(["codex", "claude"])).toBe(
      "claude-project-v1+codex-project-v3",
    );
    expect(listHosts()).toEqual(
      HOST_REGISTRY.map(({ host, supportsTemporaryProfileInstallation }) => ({
        host,
        supportsTemporaryProfileInstallation,
      })),
    );
  });

  test("exposes one complete Project-planning contract for ordinary and temporary lifetimes", async () => {
    expect(HOST_REGISTRY.map((registration) => registration.adapter.host)).toEqual([
      "antigravity",
      "claude",
      "codex",
      "grok",
      "opencode",
      "pi",
    ]);

    const project = temporaryDirectory("apkit-registry-project-");
    const home = temporaryDirectory("apkit-registry-home-");
    const bin = temporaryDirectory("apkit-registry-bin-");
    mkdirSync(join(project, ".claude", "rules"), { recursive: true });
    writeFileSync(join(bin, "claude"), "#!/bin/sh\necho '2.1.0 (Claude Code)'\n");
    chmodSync(join(bin, "claude"), 0o755);

    const claude = hostRegistrationFor("claude");
    const result = await claude.adapter.planProject(
      {
        authoredProject: project,
        checkHostCapability: true,
        env: { ...process.env, PATH: bin },
        home,
        profileId: "coding",
        previousInstallation: undefined,
        project,
        projectRelativeToGitRoot: undefined,
        resolvedContexts: [{ content: "Use tests.\n", id: "engineering" }],
        resolvedSkills: [],
        selectedHosts: ["claude"],
      },
      {
        materials: DEFAULT_ADAPTER_PLANNING_MATERIALS,
        planProjection: (_key, plan) => plan(),
        probeMachineCapability: (_requirements, probe) => probe(),
      },
    );

    expect(result.capabilityFailures).toEqual([]);
    expect(result.diagnostics).toEqual([]);
    expect(result.plan).toMatchObject({
      host: "claude",
      hostVersion: "native-project-unscoped-rules-skills-v1",
      outputs: [{ path: ".claude/rules/agent-profile-kit.md" }],
      setupSteps: [],
    });
  });

  test("runs Grok dynamic inspection and topology through its registered Adapter", async () => {
    const project = temporaryDirectory("apkit-registry-grok-project-");
    const home = temporaryDirectory("apkit-registry-grok-home-");
    const bin = temporaryDirectory("apkit-registry-grok-bin-");
    const executable = join(bin, "grok");
    writeFileSync(
      executable,
      `#!/bin/sh
if [ "$1" = "version" ]; then
  echo "grok 0.2.111"
  exit 0
fi
if [ "$1" = "inspect" ] && [ "$2" = "--json" ]; then
  echo '{"externalCompat":{"cells":[{"enabled":false,"surface":"rules","vendor":"claude"}]},"grokVersion":"0.2.111"}'
  exit 0
fi
exit 2
`,
    );
    chmodSync(executable, 0o755);

    const grok = hostRegistrationFor("grok");
    const result = await grok.adapter.planProject(
      {
        authoredProject: project,
        checkHostCapability: true,
        env: { ...process.env, PATH: bin },
        home,
        profileId: "coding",
        previousInstallation: undefined,
        project,
        projectRelativeToGitRoot: undefined,
        resolvedContexts: [{ content: "Use tests.\n", id: "engineering" }],
        resolvedSkills: [],
        selectedHosts: ["claude", "grok"],
      },
      {
        materials: DEFAULT_ADAPTER_PLANNING_MATERIALS,
        planProjection: (_key, plan) => plan(),
        probeMachineCapability: (_requirements, probe) => probe(),
      },
    );

    expect(result.capabilityFailures).toEqual([]);
    expect(result.diagnostics).toEqual([]);
    expect(result.plan).toMatchObject({
      host: "grok",
      hostVersion: "native-project-unscoped-rules-v1",
      outputs: [{ path: ".grok/rules/agent-profile-kit.md" }],
      setupSteps: [],
    });
  });

  test("requires every registered Adapter to implement detectHost and detects installed Hosts in canonical order", async () => {
    for (const registration of HOST_REGISTRY) {
      expect(typeof registration.adapter.detectHost).toBe("function");
    }

    const bin = temporaryDirectory("apkit-detect-all-bin-");
    writeFileSync(join(bin, "agy"), "#!/bin/sh\necho 'Antigravity 1.1.13'\n");
    writeFileSync(join(bin, "claude"), "#!/bin/sh\necho '2.1.0 (Claude Code)'\n");
    writeFileSync(join(bin, "codex"), "#!/bin/sh\necho 'codex-cli 0.145.0'\n");
    writeFileSync(
      join(bin, "grok"),
      `#!/bin/sh\nif [ "$1" = "version" ]; then echo 'grok 0.2.111'; exit 0; fi\nexit 2\n`,
    );
    writeFileSync(join(bin, "opencode"), "#!/bin/sh\necho '1.18.23'\n");
    writeFileSync(join(bin, "pi"), "#!/bin/sh\necho 'pi 0.82.1'\n");
    for (const name of ["agy", "claude", "codex", "grok", "opencode", "pi"]) {
      chmodSync(join(bin, name), 0o755);
    }

    const detected = await detectInstalledHosts({ env: { ...process.env, PATH: bin } });
    expect(detected).toEqual([
      "antigravity",
      "claude",
      "codex",
      "grok",
      "opencode",
      "pi",
    ]);

    // Partial detection: only codex and pi
    const partialBin = temporaryDirectory("apkit-detect-partial-bin-");
    writeFileSync(join(partialBin, "codex"), "#!/bin/sh\necho 'codex-cli 0.145.0'\n");
    writeFileSync(join(partialBin, "pi"), "#!/bin/sh\necho 'pi 0.82.1'\n");
    chmodSync(join(partialBin, "codex"), 0o755);
    chmodSync(join(partialBin, "pi"), 0o755);

    const partialDetected = await detectInstalledHosts({
      env: { ...process.env, PATH: partialBin },
    });
    expect(partialDetected).toEqual(["codex", "pi"]);

    // Empty detection on empty PATH
    const emptyBin = temporaryDirectory("apkit-detect-empty-bin-");
    const emptyDetected = await detectInstalledHosts({
      env: { ...process.env, PATH: emptyBin },
    });
    expect(emptyDetected).toEqual([]);

    // Failed/unreadable probe does not throw and returns false
    const brokenBin = temporaryDirectory("apkit-detect-broken-bin-");
    writeFileSync(join(brokenBin, "codex"), "#!/bin/sh\nexit 1\n");
    chmodSync(join(brokenBin, "codex"), 0o755);
    const brokenDetected = await detectInstalledHosts({
      env: { ...process.env, PATH: brokenBin },
    });
    expect(brokenDetected).toEqual([]);
  });
});

