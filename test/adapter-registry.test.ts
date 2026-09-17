import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fileTree } from "./support/file-tree.js";

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

    // Detection decides by executable presence on PATH alone (spec #593,
    // US-009, DEC-012): a stub that exits 1 when started still reports its
    // Host as installed, because detection never starts the executable.
    const bin = temporaryDirectory("apkit-detect-all-bin-");
    writeFileSync(join(bin, "agy"), "#!/bin/sh\nexit 1\n");
    writeFileSync(join(bin, "claude"), "#!/bin/sh\nexit 1\n");
    writeFileSync(join(bin, "codex"), "#!/bin/sh\nexit 1\n");
    writeFileSync(join(bin, "grok"), "#!/bin/sh\nexit 1\n");
    writeFileSync(join(bin, "opencode"), "#!/bin/sh\nexit 1\n");
    writeFileSync(join(bin, "pi"), "#!/bin/sh\nexit 1\n");
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
    writeFileSync(join(partialBin, "codex"), "#!/bin/sh\nexit 1\n");
    writeFileSync(join(partialBin, "pi"), "#!/bin/sh\nexit 1\n");
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

    // Presence that is not an executable file is not an installation: a
    // directory named like the Host executable and a non-executable file
    // both stay undetected (the lookup's shape rules).
    const wrongShapeBin = temporaryDirectory("apkit-detect-wrong-shape-bin-");
    mkdirSync(join(wrongShapeBin, "codex"));
    writeFileSync(join(wrongShapeBin, "pi"), "#!/bin/sh\nexit 0\n", { mode: 0o644 });
    const wrongShapeDetected = await detectInstalledHosts({
      env: { ...process.env, PATH: wrongShapeBin },
    });
    expect(wrongShapeDetected).toEqual([]);
  });

  test("detecting installed Hosts starts no Host executable and writes nothing (TEST-011)", async () => {
    // Fake Host executables that write a marker the moment they start: if
    // any detecting command spawns a Host, the marker appears and the test
    // fails. TEST-011 also compares the isolated home and working directory
    // file trees before and after detection.
    const bin = temporaryDirectory("apkit-detect-markers-bin-");
    const home = temporaryDirectory("apkit-detect-markers-home-");
    const markers = join(home, "started-markers");
    mkdirSync(markers);
    for (const [name] of [
      ["agy", "Antigravity 1.1.13"],
      ["claude", "2.1.0 (Claude Code)"],
      ["codex", "codex-cli 0.145.0"],
      ["grok", "grok 0.2.111"],
      ["opencode", "1.18.23"],
      ["pi", "pi 0.82.1"],
    ] as const) {
      // Marker via shell-builtin redirection: the stub inherits the detecting
      // command's environment, whose PATH contains only the stub bin, so an
      // external command like `touch` would not resolve.
      writeFileSync(
        join(bin, name),
        `#!/bin/sh\necho started > '${join(markers, name)}'\n`,
      );
      chmodSync(join(bin, name), 0o755);
    }

    const treeBefore = fileTree(home);
    const detected = await detectInstalledHosts({ env: { ...process.env, PATH: bin } });
    expect(detected).toEqual([
      "antigravity",
      "claude",
      "codex",
      "grok",
      "opencode",
      "pi",
    ]);

    // No Host executable was started: no marker file exists inside the
    // directory the fakes would write into.
    expect(readdirSync(markers)).toEqual([]);
    // No file in the isolated home changed.
    expect(fileTree(home)).toEqual(treeBefore);
  });

  test("one Adapter whose detectHost rejects degrades to not found without failing the inventory", async () => {
    // The per-Adapter guard in detectInstalledHosts is structural: an
    // Adapter that throws must not reject the shared detection authority
    // and take a previously infallible read-only command down with it.
    const registration = HOST_REGISTRY[0]!;
    const originalDetectHost = registration.adapter.detectHost.bind(registration.adapter);
    registration.adapter.detectHost = () => Promise.reject(new Error("adapter probe rejected"));
    try {
      const bin = temporaryDirectory("apkit-detect-throwing-bin-");
      // Stubs for the five non-throwing Adapters; the throwing Adapter's
      // probe rejects before touching PATH.
      for (const [name, output] of [
        ["claude", "2.1.0 (Claude Code)"],
        ["codex", "codex-cli 0.145.0"],
        ["grok", "grok 0.2.111"],
        ["opencode", "1.18.23"],
        ["pi", "pi 0.82.1"],
      ] as const) {
        writeFileSync(join(bin, name), `#!/bin/sh\necho '${output}'\n`);
        chmodSync(join(bin, name), 0o755);
      }

      const detected = await detectInstalledHosts({ env: { ...process.env, PATH: bin } });

      expect(detected).toEqual(["claude", "codex", "grok", "opencode", "pi"]);
    } finally {
      registration.adapter.detectHost = originalDetectHost;
    }
  });
});

