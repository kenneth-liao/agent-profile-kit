import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "yaml";

import {
  formatInstallationManifest,
  formatInstallationState,
  parseInstallationManifest,
  parseInstallationState,
  type ProjectInstallationManifest,
} from "../schemas/installation-manifest.js";
import { initializeWorkspace } from "../installer/initialize-workspace.js";
import {
  assertResolvedOutputOrigins,
  buildDesiredState,
  type DesiredInstallation,
} from "../installer/project-plan.js";
import {
  applyReconciliation,
  previewReconciliation,
} from "../installer/reconcile.js";
import {
  readInstallationState,
  readInstallationStateWithMigration,
} from "../installer/installation-state.js";
import { artifactReferenceKey } from "../schemas/dependencies.js";

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

const hash = `sha256:${"0".repeat(64)}`;

/** A manifest whose provenance records every output and every resolved artifact. */
function completeManifest(): ProjectInstallationManifest {
  return {
    adapterVersion: "test-adapter",
    engineVersion: "test-engine",
    gitProject: true,
    hosts: ["claude", "codex"],
    hostVersions: { claude: "claude-v1", codex: "codex-v1" },
    installationId: "install-a",
    outputOrigins: {
      ".agent-profile-kit/installation.json": [],
      ".claude/rules/agent-profile-kit.md": [
        { id: "team-rules", type: "context" },
      ],
      ".agents/skills/review-pr": [{ id: "review-pr", type: "skill" }],
    },
    outputs: [
      { hash, mode: 0o644, path: ".agent-profile-kit/installation.json", type: "file" },
      { hash, mode: 0o644, path: ".claude/rules/agent-profile-kit.md", type: "file" },
      {
        hash,
        members: [{ hash, mode: 0o644, path: "SKILL.md", type: "file" }],
        mode: 0o755,
        path: ".agents/skills/review-pr",
        type: "directory",
      },
    ],
    profileId: "coding",
    project: "/repo/a",
    resolvedArtifacts: [
      {
        fingerprint: hash,
        inclusionReasons: [{ path: [], profile: "coding" }],
        reference: { id: "team-rules", type: "context" },
      },
      {
        fingerprint: hash,
        inclusionReasons: [{
          path: [{ id: "review-pr", type: "skill" }],
          profile: "coding",
        }],
        reference: { id: "review-pr", type: "skill" },
      },
    ],
    schemaVersion: 3,
    selectedContext: ["team-rules"],
    workspaceInputHash: hash,
  };
}

function manifestWithoutProvenance(): Record<string, unknown> {
  return {
    schema_version: 2,
    installation_id: "install-a",
    project: "/repo/a",
    profile_id: "coding",
    selected_context: ["team-rules"],
    resolved_artifacts: [{
      id: "team-rules",
      inclusion_reasons: [{ path: [], profile: "coding" }],
      type: "context",
    }],
    hosts: ["codex"],
    host_versions: { codex: "codex-v1" },
    adapter_version: "test-adapter",
    engine_version: "test-engine",
    git_project: true,
    workspace_input_hash: hash,
    outputs: [
      { hash, mode: 0o644, path: ".agent-profile-kit/installation.json", type: "file" },
    ],
  };
}

describe("Installation Manifest provenance evidence", () => {
  test("round-trips normalized fingerprints and typed output origins", () => {
    const manifest = completeManifest();
    const parsed = parseInstallationManifest(formatInstallationManifest(manifest));

    expect(parsed).toEqual(manifest);
  });

  test("records zero, one, and multiple canonical origins per output without path inference", () => {
    const manifest: ProjectInstallationManifest = {
      ...completeManifest(),
      outputs: [
        ...completeManifest().outputs,
        {
          hash,
          mode: 0o644,
          path: ".claude/rules/team-rules.md",
          type: "file",
        },
      ],
      outputOrigins: {
        ...completeManifest().outputOrigins,
        ".claude/rules/team-rules.md": [
          { id: "team-rules", type: "context" },
          { id: "team-style", type: "context" },
        ],
      },
      resolvedArtifacts: [
        ...completeManifest().resolvedArtifacts,
        {
          fingerprint: hash,
          inclusionReasons: [{ path: [], profile: "coding" }],
          reference: { id: "team-style", type: "context" },
        },
      ],
    };

    const parsed = parseInstallationManifest(formatInstallationManifest(manifest));

    expect(parsed.outputOrigins?.[".claude/rules/team-rules.md"]).toEqual([
      { id: "team-rules", type: "context" },
      { id: "team-style", type: "context" },
    ]);
    expect(parsed.outputOrigins?.[".agent-profile-kit/installation.json"]).toEqual([]);
    expect(parsed.outputOrigins?.[".agents/skills/review-pr"]).toEqual([
      { id: "review-pr", type: "skill" },
    ]);
  });

  test("rejects malformed fingerprint evidence", () => {
    const manifest = completeManifest();
    const source = parse(formatInstallationManifest(manifest)) as Record<string, unknown>;
    const artifacts = source.resolved_artifacts as Record<string, unknown>[];
    artifacts[0]!.fingerprint = "md5:deadbeef";

    expect(() => parseInstallationManifest(stringify(source))).toThrow(
      /resolved_artifacts\[0\] fingerprint must be a SHA-256 hash/,
    );
  });

  test("rejects duplicate origin references within one output", () => {
    const manifest = completeManifest();
    const source = parse(formatInstallationManifest(manifest)) as Record<string, unknown>;
    const origins = (source.output_origins as Record<string, unknown>)[".agents/skills/review-pr"] as unknown[];
    origins.push({ id: "review-pr", type: "skill" });

    expect(() => parseInstallationManifest(stringify(source))).toThrow(
      /output_origins\.\.agents\/skills\/review-pr must not contain an Artifact reference more than once/,
    );
  });

  test("rejects duplicate resolved artifact identity in provenance evidence", () => {
    const manifest = completeManifest();
    const source = parse(formatInstallationManifest(manifest)) as Record<string, unknown>;
    const artifacts = source.resolved_artifacts as unknown[];
    artifacts.push({ ...(artifacts[0] as Record<string, unknown>) });

    expect(() => parseInstallationManifest(stringify(source))).toThrow(
      /resolved_artifacts must not contain an Artifact more than once/,
    );
  });

  test("rejects origin evidence that references an unrecorded artifact", () => {
    const manifest = completeManifest();
    const source = parse(formatInstallationManifest(manifest)) as Record<string, unknown>;
    (source.output_origins as Record<string, unknown>)[".agents/skills/review-pr"] = [
      { id: "ghost-skill", type: "skill" },
    ];

    expect(() => parseInstallationManifest(stringify(source))).toThrow(
      /output_origins\.\.agents\/skills\/review-pr references artifact 'skill:ghost-skill' that is not recorded in resolved_artifacts/,
    );
  });

  test("rejects output origins that omit or invent output paths", () => {
    const missing = parse(formatInstallationManifest(completeManifest())) as Record<string, unknown>;
    delete (missing.output_origins as Record<string, unknown>)[".agents/skills/review-pr"];

    expect(() => parseInstallationManifest(stringify(missing))).toThrow(
      /output_origins must cover output '\.agents\/skills\/review-pr'/,
    );

    const invented = parse(formatInstallationManifest(completeManifest())) as Record<string, unknown>;
    (invented.output_origins as Record<string, unknown>)[".agents/skills/ghost"] = [];

    expect(() => parseInstallationManifest(stringify(invented))).toThrow(
      /references unknown output path '\.agents\/skills\/ghost'/,
    );
  });

  test("rejects partial provenance evidence", () => {
    const originsOnly = parse(formatInstallationManifest(completeManifest())) as Record<string, unknown>;
    const artifacts = originsOnly.resolved_artifacts as Record<string, unknown>[];
    for (const artifact of artifacts) delete artifact.fingerprint;

    expect(() => parseInstallationManifest(stringify(originsOnly))).toThrow(
      /resolved_artifacts fingerprints require output_origins|output_origins requires a fingerprint for every resolved artifact/,
    );

    const fingerprintsOnly = manifestWithoutProvenance();
    const withFingerprints = parse(JSON.stringify(fingerprintsOnly)) as Record<string, unknown>;
    (withFingerprints.resolved_artifacts as Record<string, unknown>[])[0]!.fingerprint = hash;

    expect(() => parseInstallationManifest(stringify(withFingerprints))).toThrow(
      /resolved_artifacts fingerprints require output_origins/,
    );
  });

  test("ingests a legacy manifest without provenance through the state boundary", () => {
    const state = stringify({
      schema_version: 5,
      intended_teardowns: [],
      installations: [manifestWithoutProvenance()],
      repository_exclusions: [],
      temporary_installations: [],
    });

    const parsed = parseInstallationState(state);

    expect(parsed.installations[0]).toMatchObject({
      installationId: "install-a",
      schemaVersion: 3,
    });
    expect(parsed.installations[0]?.outputOrigins).toBeUndefined();
    expect(parsed.installations[0]?.resolvedArtifacts[0]?.fingerprint).toBeUndefined();
    expect(parsed.installations[0]?.outputs).toEqual([
      { hash, mode: 0o644, path: ".agent-profile-kit/installation.json", type: "file" },
    ]);
  });

  test("round-trips a provenance-absent manifest through Installation State without inventing evidence", () => {
    const parsed = parseInstallationState(stringify({
      schema_version: 5,
      intended_teardowns: [],
      installations: [manifestWithoutProvenance()],
      repository_exclusions: [],
      temporary_installations: [],
    }));
    const state = {
      intendedTeardowns: [],
      installations: parsed.installations,
      repositoryExclusions: [],
      schemaVersion: 5 as const,
      temporaryInstallations: [],
    };

    const replayed = parseInstallationState(formatInstallationState(state));

    expect(replayed.installations[0]?.outputOrigins).toBeUndefined();
    expect(replayed.installations[0]?.resolvedArtifacts[0]?.fingerprint).toBeUndefined();
    expect(replayed.installations[0]?.installationId).toBe("install-a");
  });
});

async function desiredWithContextAndSkill(
  home: string,
  project: string,
  skillBody: string,
  contextIds: readonly string[] = ["team-rules"],
): Promise<DesiredInstallation> {
  await initializeWorkspace(home);
  const application = join(home, ".agents", "agent-profile-kit");
  const workspace = join(application, "workspace");
  for (const id of contextIds) {
    const contextRoot = join(workspace, "context", id);
    mkdirSync(contextRoot, { recursive: true });
    writeFileSync(
      join(contextRoot, "CONTEXT.md"),
      `---\nid: ${id}\ndependencies: []\n---\nContext ${id}.\n`,
    );
  }
  const skillRoot = join(workspace, "skills", "review-pr");
  mkdirSync(skillRoot, { recursive: true });
  writeFileSync(join(skillRoot, "SKILL.md"), skillBody);
  writeFileSync(
    join(workspace, "profiles", "coding.yaml"),
    `id: coding\ncontext: [${contextIds.join(", ")}]\nskills: [review-pr]\nagents: []\nhooks: []\ntools: []\n`,
  );
  writeFileSync(
    join(application, "config.yaml"),
    `schema_version: 2\nworkspace: ${workspace}\nbindings:\n  - project: ${project}\n    profile: coding\n    hosts: [codex]\n`,
  );
  const desired = await buildDesiredState(home, { checkHostCapability: false });
  const installation = desired.installations[0];
  if (!installation) throw new Error("expected one desired installation");
  return installation;
}

describe("Receipt provenance at the planning boundary", () => {
  test("fingerprints every resolved artifact with a normalized hash", async () => {
    const home = temporaryDirectory("apk-fp-home-");
    const project = temporaryDirectory("apk-fp-project-");
    const installation = await desiredWithContextAndSkill(
      home,
      project,
      "---\nname: review-pr\ndescription: Review a pull request.\n---\n\n# Review\n",
    );

    expect(
      installation.artifactFingerprints
        .map((fingerprint) => artifactReferenceKey(fingerprint.reference))
        .sort(),
    ).toEqual(["context:team-rules", "skill:review-pr"]);
    for (const fingerprint of installation.artifactFingerprints) {
      expect(fingerprint.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    }
  });

  test("changes only the fingerprint of the artifact whose source changed", async () => {
    const home = temporaryDirectory("apk-fp-change-home-");
    const project = temporaryDirectory("apk-fp-change-project-");
    const first = await desiredWithContextAndSkill(
      home,
      project,
      "---\nname: review-pr\ndescription: Review a pull request.\n---\n\n# Review\n",
    );
    const second = await desiredWithContextAndSkill(
      home,
      project,
      "---\nname: review-pr\ndescription: Review a pull request.\n---\n\n# Review\n\nChanged body.\n",
    );

    const fingerprintFor = (installation: DesiredInstallation, id: string): string =>
      installation.artifactFingerprints.find(
        (fingerprint) => fingerprint.reference.id === id,
      )!.fingerprint;

    expect(fingerprintFor(second, "review-pr")).not.toBe(fingerprintFor(first, "review-pr"));
    expect(fingerprintFor(second, "team-rules")).toBe(fingerprintFor(first, "team-rules"));
  });

  test("labels each ordinary output with typed source origins", async () => {
    const home = temporaryDirectory("apk-origin-home-");
    const project = temporaryDirectory("apk-origin-project-");
    const installation = await desiredWithContextAndSkill(
      home,
      project,
      "---\nname: review-pr\ndescription: Review a pull request.\n---\n\n# Review\n",
    );

    const originsByPath = new Map(
      installation.outputs.map((output) => [output.path, output.origins]),
    );
    expect(originsByPath.get(".agent-profile-kit/codex/context.md")).toEqual([
      { id: "team-rules", type: "context" },
    ]);
    expect(originsByPath.get(".codex/hooks.json")).toEqual([]);
    expect(originsByPath.get(".agents/skills/review-pr")).toEqual([
      { id: "review-pr", type: "skill" },
    ]);
  });

  test("attributes one Context output to every contributing Context Module", async () => {
    const home = temporaryDirectory("apk-origin-multi-home-");
    const project = temporaryDirectory("apk-origin-multi-project-");
    const installation = await desiredWithContextAndSkill(
      home,
      project,
      "---\nname: review-pr\ndescription: Review a pull request.\n---\n\n# Review\n",
      ["team-rules", "team-style"],
    );

    const contextOutput = installation.outputs.find(
      (output) => output.path === ".agent-profile-kit/codex/context.md",
    );
    expect(contextOutput?.origins).toEqual([
      { id: "team-rules", type: "context" },
      { id: "team-style", type: "context" },
    ]);
  });

  test("planning rejects output origins that reference artifacts outside the resolved Profile", async () => {
    const home = temporaryDirectory("apk-origin-unknown-home-");
    const project = temporaryDirectory("apk-origin-unknown-project-");
    const installation = await desiredWithContextAndSkill(
      home,
      project,
      "---\nname: review-pr\ndescription: Review a pull request.\n---\n\n# Review\n",
    );
    const withForeignOrigin = {
      ...installation,
      outputs: installation.outputs.map((output) =>
        output.path === ".agents/skills/review-pr"
          ? { ...output, origins: [{ id: "ghost-skill", type: "skill" as const }] }
          : output,
      ),
    };

    expect(() =>
      assertResolvedOutputOrigins(
        withForeignOrigin.outputs,
        withForeignOrigin.resolvedProfile,
      ),
    ).toThrow(
      /Adapter output '\.agents\/skills\/review-pr' references artifact 'skill:ghost-skill' that is not resolved for Profile 'coding'/,
    );
  });
});

describe("Provenance recorded on ordinary apply", () => {
  test("a successful apply records fingerprints and typed origins in the Installation Manifest", async () => {
    const home = temporaryDirectory("apk-manifest-home-");
    const project = temporaryDirectory("apk-manifest-project-");
    const desired = await desiredWithContextAndSkill(
      home,
      project,
      "---\nname: review-pr\ndescription: Review a pull request.\n---\n\n# Review\n",
    );
    await applyReconciliation(home, [desired]);

    const state = await readInstallationState(home);
    const manifest = state.installations[0]!;
    expect(manifest.schemaVersion).toBe(3);
    expect(manifest.outputOrigins).toEqual({
      ".agent-profile-kit/installation.json": [],
      ".agent-profile-kit/codex/context.md": [{ id: "team-rules", type: "context" }],
      ".codex/hooks.json": [],
      ".agents/skills/review-pr": [{ id: "review-pr", type: "skill" }],
    });
    expect(
      manifest.resolvedArtifacts
        .map((artifact) => artifactReferenceKey(artifact.reference))
        .sort(),
    ).toEqual(["context:team-rules", "skill:review-pr"]);
    for (const artifact of manifest.resolvedArtifacts) {
      expect(artifact.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    }
  });
});

function legacyManifestValue(manifest: ProjectInstallationManifest): Record<string, unknown> {
  return {
    schema_version: 2,
    installation_id: manifest.installationId,
    project: manifest.project,
    profile_id: manifest.profileId,
    selected_context: manifest.selectedContext,
    resolved_artifacts: manifest.resolvedArtifacts.map((artifact) => ({
      type: artifact.reference.type,
      id: artifact.reference.id,
      inclusion_reasons: artifact.inclusionReasons,
    })),
    hosts: manifest.hosts,
    host_versions: manifest.hostVersions,
    adapter_version: manifest.adapterVersion,
    engine_version: manifest.engineVersion,
    ...(manifest.gitProject === undefined ? {} : { git_project: manifest.gitProject }),
    workspace_input_hash: manifest.workspaceInputHash,
    outputs: manifest.outputs.map((output) =>
      output.type === "file"
        ? { path: output.path, type: output.type, mode: output.mode, hash: output.hash }
        : {
            path: output.path,
            type: output.type,
            mode: output.mode,
            hash: output.hash,
            members: output.members.map((member) =>
              member.type === "file"
                ? { path: member.path, type: member.type, mode: member.mode, hash: member.hash }
                : { path: member.path, type: member.type, mode: member.mode },
            ),
          },
    ),
  };
}

describe("Legacy receipt migration and backfill", () => {
  test("a legacy manifest stays current and gains canonical provenance on the next ordinary apply", async () => {
    const home = temporaryDirectory("apk-backfill-home-");
    const project = temporaryDirectory("apk-backfill-project-");
    const desired = await desiredWithContextAndSkill(
      home,
      project,
      "---\nname: review-pr\ndescription: Review a pull request.\n---\n\n# Review\n",
    );
    // Produce real owned output, then rewrite Installation State as a legacy v5
    // file containing a provenance-absent v2 manifest.
    await applyReconciliation(home, [desired]);
    const applied = await readInstallationState(home);
    const recorded = applied.installations[0]!;
    writeFileSync(
      join(home, ".agents", "agent-profile-kit", "state", "manifest.yaml"),
      stringify({
        schema_version: 5,
        intended_teardowns: [],
        installations: [legacyManifestValue(recorded)],
        repository_exclusions: [],
        temporary_installations: [],
      }),
    );

    const loaded = await readInstallationStateWithMigration(home);
    expect(loaded.migrated).toBe(true);
    expect(loaded.state.installations[0]?.outputOrigins).toBeUndefined();

    const preview = await previewReconciliation([desired], loaded.state);
    expect(preview.items).toContainEqual({ kind: "current", project: desired.binding.project });
    expect(preview.blockers).toHaveLength(0);

    await applyReconciliation(home, [desired]);

    const enriched = await readInstallationState(home);
    const manifest = enriched.installations[0]!;
    expect(manifest.installationId).toBe(recorded.installationId);
    expect(manifest.hosts).toEqual(recorded.hosts);
    expect(manifest.outputs).toEqual(recorded.outputs);
    expect(manifest.workspaceInputHash).toBe(recorded.workspaceInputHash);
    expect(manifest.outputOrigins).toEqual({
      ".agent-profile-kit/installation.json": [],
      ".agent-profile-kit/codex/context.md": [{ id: "team-rules", type: "context" }],
      ".codex/hooks.json": [],
      ".agents/skills/review-pr": [{ id: "review-pr", type: "skill" }],
    });
    for (const artifact of manifest.resolvedArtifacts) {
      expect(artifact.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    }
    expect(manifest.resolvedArtifacts.map((artifact) => artifact.reference.id).sort()).toEqual([
      "review-pr",
      "team-rules",
    ]);
  });
});

describe("Temporary Profile Installation receipts stay provenance-free", () => {
  test("temporary records carry no provenance and coexist with legacy ordinary manifests", () => {
    const state = stringify({
      schema_version: 5,
      intended_teardowns: [],
      installations: [manifestWithoutProvenance()],
      repository_exclusions: [],
      temporary_installations: [{
        temporary_installation_id: "temp-1",
        completion_state: "installed",
        profile_id: "coding",
        host: "codex",
        project: "/tmp/temp-project",
        adapter_version: "test-adapter",
        engine_version: "test-engine",
        host_version: "codex-v1",
        workspace_input_hash: hash,
        outputs: [{
          path: ".agent-profile-kit/installation.json",
          type: "file",
          mode: 0o644,
          hash,
        }],
      }],
    });

    const parsed = parseInstallationState(state);

    expect(parsed.temporaryInstallations[0]).toEqual({
      adapterVersion: "test-adapter",
      completionState: "installed",
      engineVersion: "test-engine",
      host: "codex",
      hostVersion: "codex-v1",
      outputs: [{ hash, mode: 0o644, path: ".agent-profile-kit/installation.json", type: "file" }],
      profileId: "coding",
      project: "/tmp/temp-project",
      temporaryInstallationId: "temp-1",
      workspaceInputHash: hash,
    });

    const replayed = parseInstallationState(formatInstallationState(parsed));
    expect(replayed.temporaryInstallations).toEqual(parsed.temporaryInstallations);
    expect(replayed.installations[0]?.outputOrigins).toBeUndefined();
  });
});
