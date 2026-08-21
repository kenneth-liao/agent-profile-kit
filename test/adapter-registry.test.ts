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
    expect(HOST_REGISTRY.map((registration) => registration.ordinaryPlanning)).toEqual([
      "legacy",
      "complete",
      "complete",
      "legacy",
      "legacy",
    ]);

    expect(isSupportedHost("claude")).toBe(true);
    expect(isSupportedHost("unknown")).toBe(false);
    expect(hostRegistrationFor("claude")).toMatchObject({
      adapterVersion: "claude-project-v1",
      host: "claude",
      ordinaryPlanning: "complete",
      supportsTemporaryProfileInstallation: true,
    });
    expect(hostRegistrationFor("pi")).toMatchObject({
      adapterVersion: "pi-project-v2",
      host: "pi",
      ordinaryPlanning: "legacy",
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

  test("exposes the complete ordinary-planning contract only for migrated Hosts", async () => {
    const complete = HOST_REGISTRY.filter(
      (registration) => registration.ordinaryPlanning === "complete",
    );
    expect(complete.map((registration) => registration.host)).toEqual(["claude", "codex"]);
    expect(complete.every((registration) => "adapter" in registration)).toBe(true);
    expect(
      HOST_REGISTRY.filter((registration) => registration.ordinaryPlanning === "legacy")
        .every((registration) => !("adapter" in registration)),
    ).toBe(true);

    const project = temporaryDirectory("apkit-registry-project-");
    const home = temporaryDirectory("apkit-registry-home-");
    const bin = temporaryDirectory("apkit-registry-bin-");
    mkdirSync(join(project, ".claude", "rules"), { recursive: true });
    writeFileSync(join(bin, "claude"), "#!/bin/sh\necho '2.1.0 (Claude Code)'\n");
    chmodSync(join(bin, "claude"), 0o755);

    const claude = hostRegistrationFor("claude");
    if (claude.ordinaryPlanning !== "complete") throw new Error("Claude Adapter is not complete");
    const result = await claude.adapter.planOrdinaryProject(
      {
        authoredProject: project,
        checkHostCapability: true,
        env: { ...process.env, PATH: bin },
        home,
        profileId: "coding",
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
});
