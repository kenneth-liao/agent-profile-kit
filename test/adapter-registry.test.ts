import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_ADAPTER_PLANNING_MATERIALS } from "../adapters/skill-package.js";

import {
  HOST_REGISTRY,
  SUPPORTED_HOSTS,
  adapterVersionFor,
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
      "pi",
    ]);
    expect(HOST_REGISTRY.map((registration) => registration.host)).toEqual([...SUPPORTED_HOSTS]);
    expect(isSupportedHost("claude")).toBe(true);
    expect(isSupportedHost("unknown")).toBe(false);
    expect(hostRegistrationFor("claude")).toMatchObject({
      adapterVersion: "claude-project-v1",
      host: "claude",
      supportsTemporaryProfileInstallation: true,
    });
    expect(hostRegistrationFor("pi")).toMatchObject({
      adapterVersion: "pi-project-v2",
      host: "pi",
      supportsTemporaryProfileInstallation: false,
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
});
