import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { skillPackageMembers } from "../adapters/skill-package.js";
import { initializeWorkspace } from "../installer/initialize-workspace.js";
import {
  buildDesiredState,
  type LifecyclePlanningInstrumentation,
} from "../installer/project-plan.js";

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
  readonly counts: {
    composeContext: number;
    hashWorkspaceInputs: number;
    planHost: number;
    readSkillPackage: number;
    resolveProfile: number;
  };
} {
  const counts = {
    composeContext: 0,
    hashWorkspaceInputs: 0,
    planHost: 0,
    readSkillPackage: 0,
    resolveProfile: 0,
  };
  return {
    counts,
    onComposeContext: () => {
      counts.composeContext += 1;
    },
    onHashWorkspaceInputs: () => {
      counts.hashWorkspaceInputs += 1;
    },
    onPlanHost: () => {
      counts.planHost += 1;
    },
    onReadSkillPackage: () => {
      counts.readSkillPackage += 1;
    },
    onResolveProfile: () => {
      counts.resolveProfile += 1;
    },
  };
}

function writeSkill(workspace: string, id: string, body = `# ${id}\n`): void {
  const skillRoot = join(workspace, "skills", id);
  mkdirSync(join(skillRoot, "scripts"), { recursive: true });
  writeFileSync(
    join(skillRoot, "SKILL.md"),
    `---\nname: ${id}\ndescription: Skill ${id}.\n---\n\n${body}`,
  );
  writeFileSync(
    join(skillRoot, "scripts", "run.sh"),
    `#!/bin/sh\necho ${id}\n`,
  );
}

async function multiProjectWorkspace(options: {
  readonly home: string;
  readonly hostsByProject?: readonly (readonly string[])[];
  readonly profileCount?: number;
  readonly projectCount: number;
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
  writeSkill(workspace, "review-pr", "# Review a pull request.\n");
  writeFileSync(
    join(workspace, "profiles", "engineering.yaml"),
    "id: engineering\ncontext: [team-rules]\nskills: [review-pr]\n",
  );
  if ((options.profileCount ?? 1) > 1) {
    writeFileSync(
      join(workspace, "context", "ops-rules.md"),
      "---\nid: ops-rules\ndependencies: []\n---\nOperations preferences.\n",
    );
    writeFileSync(
      join(workspace, "profiles", "operations.yaml"),
      "id: operations\ncontext: [ops-rules]\nskills: [review-pr]\n",
    );
  }
  const projects: string[] = [];
  const bindingLines: string[] = [];
  for (let index = 0; index < options.projectCount; index += 1) {
    const project = temporaryDirectory(`apk-lifecycle-project-${index}-`);
    projects.push(project);
    const hosts = options.hostsByProject?.[index] ?? ["codex"];
    const profile =
      (options.profileCount ?? 1) > 1 && index % 2 === 1 ? "operations" : "engineering";
    bindingLines.push(
      `  - project: ${project}\n    profile: ${profile}\n    hosts: [${hosts.join(", ")}]\n`,
    );
  }
  writeFileSync(
    join(application, "config.yaml"),
    `schema_version: 2\nworkspace: ${workspace}\nbindings:\n${bindingLines.join("")}`,
  );
  return projects;
}

describe("lifecycle planning reuse within one invocation", () => {
  test("resolves and fingerprints each unique Profile input set once across Projects", async () => {
    const home = temporaryDirectory("apk-lifecycle-reuse-profile-");
    await multiProjectWorkspace({ home, projectCount: 4 });
    const instrumentation = emptyInstrumentation();

    const desired = await buildDesiredState(home, {
      checkHostCapability: false,
      planningInstrumentation: instrumentation,
    });

    expect(desired.installations).toHaveLength(4);
    expect(new Set(desired.installations.map((item) => item.sourceHash)).size).toBe(1);
    expect(instrumentation.counts.resolveProfile).toBe(1);
    expect(instrumentation.counts.hashWorkspaceInputs).toBe(1);
    expect(instrumentation.counts.readSkillPackage).toBe(1);
  });

  test("reads each resolved Skill package once across Hosts and reuses identical Host projections", async () => {
    const home = temporaryDirectory("apk-lifecycle-reuse-hosts-");
    await multiProjectWorkspace({
      home,
      hostsByProject: [
        ["codex", "claude", "pi"],
        ["codex", "claude", "pi"],
        ["codex", "claude", "pi"],
      ],
      projectCount: 3,
    });
    const instrumentation = emptyInstrumentation();

    const desired = await buildDesiredState(home, {
      checkHostCapability: false,
      planningInstrumentation: instrumentation,
    });

    expect(desired.installations).toHaveLength(3);
    expect(instrumentation.counts.readSkillPackage).toBe(1);
    expect(instrumentation.counts.composeContext).toBe(1);
    // One plan per Host for the shared Profile material and identical options.
    expect(instrumentation.counts.planHost).toBe(3);
    for (const installation of desired.installations) {
      expect(installation.outputs.map((output) => output.path).sort()).toEqual(
        desired.installations[0]!.outputs.map((output) => output.path).sort(),
      );
      expect(installation.sourceHash).toBe(desired.installations[0]!.sourceHash);
    }
  });

  test("keeps Codex Project-relative Context topology out of the shared projection key", async () => {
    const home = temporaryDirectory("apk-lifecycle-reuse-codex-topology-");
    await initializeWorkspace(home);
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex", "config.toml"), "[features]\nhooks = true\n");
    const application = join(home, ".agents", "agent-profile-kit");
    const workspace = join(application, "workspace");
    writeFileSync(
      join(workspace, "context", "team-rules.md"),
      "---\nid: team-rules\ndependencies: []\n---\nAlways preserve the project boundary.\n",
    );
    writeSkill(workspace, "review-pr");
    writeFileSync(
      join(workspace, "profiles", "engineering.yaml"),
      "id: engineering\ncontext: [team-rules]\nskills: [review-pr]\n",
    );

    // Git root with a nested bound Project changes Codex's relative context path.
    const repo = temporaryDirectory("apk-lifecycle-git-root-");
    const nested = join(repo, "apps", "service");
    mkdirSync(nested, { recursive: true });
    const { execFileSync } = await import("node:child_process");
    execFileSync("git", ["init"], { cwd: repo });
    const plain = temporaryDirectory("apk-lifecycle-plain-");
    writeFileSync(
      join(application, "config.yaml"),
      `schema_version: 2\nworkspace: ${workspace}\nbindings:\n` +
        `  - project: ${nested}\n    profile: engineering\n    hosts: [codex]\n` +
        `  - project: ${plain}\n    profile: engineering\n    hosts: [codex]\n` +
        `  - project: ${temporaryDirectory("apk-lifecycle-plain-2-")}\n    profile: engineering\n    hosts: [codex]\n`,
    );
    const instrumentation = emptyInstrumentation();

    const desired = await buildDesiredState(home, {
      checkHostCapability: false,
      planningInstrumentation: instrumentation,
    });

    expect(desired.installations).toHaveLength(3);
    expect(instrumentation.counts.resolveProfile).toBe(1);
    expect(instrumentation.counts.readSkillPackage).toBe(1);
    // Nested Git relative path differs from plain-root paths, so Codex plans twice.
    expect(instrumentation.counts.planHost).toBe(2);

    const hooks = desired.installations.map((installation) => {
      const output = installation.outputs.find((item) => item.path === ".codex/hooks.json");
      if (!output || output.type !== "file") throw new Error("missing hooks.json");
      return typeof output.bytes === "string"
        ? output.bytes
        : Buffer.from(output.bytes).toString("utf8");
    });
    expect(hooks[0]).not.toBe(hooks[1]);
    // The two plain Projects share identical topology and therefore identical hooks.
    const plainHooks = desired.installations
      .filter((installation) => installation.gitProject === undefined)
      .map((installation) => {
        const output = installation.outputs.find((item) => item.path === ".codex/hooks.json");
        if (!output || output.type !== "file") throw new Error("missing hooks.json");
        return typeof output.bytes === "string"
          ? output.bytes
          : Buffer.from(output.bytes).toString("utf8");
      });
    expect(plainHooks).toHaveLength(2);
    expect(plainHooks[0]).toBe(plainHooks[1]);
  });

  test("reuses nothing across separate lifecycle invocations", async () => {
    const home = temporaryDirectory("apk-lifecycle-reuse-invocation-");
    await multiProjectWorkspace({ home, projectCount: 2 });
    const first = emptyInstrumentation();
    const second = emptyInstrumentation();

    await buildDesiredState(home, {
      checkHostCapability: false,
      planningInstrumentation: first,
    });
    await buildDesiredState(home, {
      checkHostCapability: false,
      planningInstrumentation: second,
    });

    expect(first.counts.resolveProfile).toBe(1);
    expect(second.counts.resolveProfile).toBe(1);
    expect(first.counts.readSkillPackage).toBe(1);
    expect(second.counts.readSkillPackage).toBe(1);
    expect(first.counts.hashWorkspaceInputs).toBe(1);
    expect(second.counts.hashWorkspaceInputs).toBe(1);
  });

  test("fingerprints distinct Profiles separately while sharing one Skill package read", async () => {
    const home = temporaryDirectory("apk-lifecycle-reuse-two-profiles-");
    await multiProjectWorkspace({ home, profileCount: 2, projectCount: 4 });
    const instrumentation = emptyInstrumentation();

    const desired = await buildDesiredState(home, {
      checkHostCapability: false,
      planningInstrumentation: instrumentation,
    });

    expect(desired.installations).toHaveLength(4);
    expect(new Set(desired.installations.map((item) => item.profile.id)).size).toBe(2);
    expect(instrumentation.counts.resolveProfile).toBe(2);
    expect(instrumentation.counts.hashWorkspaceInputs).toBe(2);
    expect(instrumentation.counts.readSkillPackage).toBe(1);
    expect(instrumentation.counts.composeContext).toBe(2);
  });

  test("Skill fingerprints keep historical code-point DFS order for SKILL.md before scripts", async () => {
    const home = temporaryDirectory("apk-lifecycle-hash-order-home-");
    const project = temporaryDirectory("apk-lifecycle-hash-order-project-");
    await initializeWorkspace(home);
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex", "config.toml"), "[features]\nhooks = true\n");
    const application = join(home, ".agents", "agent-profile-kit");
    const workspace = join(application, "workspace");
    writeFileSync(
      join(workspace, "context", "team-rules.md"),
      "---\nid: team-rules\ndependencies: []\n---\nAlways preserve the project boundary.\n",
    );
    const skillRoot = join(workspace, "skills", "review-pr");
    mkdirSync(join(skillRoot, "scripts"), { recursive: true });
    const skillMd =
      "---\nname: review-pr\ndescription: Skill review-pr.\n---\n\n# Review\n";
    const script = "#!/bin/sh\necho review\n";
    writeFileSync(join(skillRoot, "SKILL.md"), skillMd);
    writeFileSync(join(skillRoot, "scripts", "run.sh"), script, { mode: 0o755 });
    chmodSync(join(skillRoot, "scripts", "run.sh"), 0o755);
    writeFileSync(
      join(workspace, "profiles", "engineering.yaml"),
      "id: engineering\ncontext: [team-rules]\nskills: [review-pr]\n",
    );
    writeFileSync(
      join(application, "config.yaml"),
      `schema_version: 2\nworkspace: ${workspace}\nbindings:\n  - project: ${project}\n    profile: engineering\n    hosts: [codex]\n`,
    );

    const members = await skillPackageMembers({
      dependencies: [],
      id: "review-pr",
      modelInvocation: "allowed",
      path: skillRoot,
    });
    const localeOrderedPaths = [...members]
      .sort((left, right) => left.path.localeCompare(right.path))
      .map((member) => member.path);
    // Guard the fixture: locale-aware order must differ from historical DFS order
    // or this regression would not catch the hash break.
    expect(localeOrderedPaths[0]).toBe("scripts");

    const sha = (source: string | Uint8Array) =>
      `sha256:${createHash("sha256").update(source).digest("hex")}`;
    const scriptMember = members.find(
      (member) => member.type === "file" && member.path === "scripts/run.sh",
    );
    const skillMember = members.find(
      (member) => member.type === "file" && member.path === "SKILL.md",
    );
    const scriptsDir = members.find(
      (member) => member.type === "directory" && member.path === "scripts",
    );
    if (!scriptMember || scriptMember.type !== "file") throw new Error("missing script");
    if (!skillMember || skillMember.type !== "file") throw new Error("missing SKILL.md");
    if (!scriptsDir || scriptsDir.type !== "directory") throw new Error("missing scripts dir");

    // Historical Skill-input shape: DFS of code-point-sorted names → SKILL.md, scripts, run.sh.
    const historicalInput = {
      files: [
        {
          content: sha(skillMember.bytes),
          mode: skillMember.mode,
          path: "SKILL.md",
          type: "file",
        },
        { mode: scriptsDir.mode, path: "scripts", type: "directory" },
        {
          content: sha(scriptMember.bytes),
          mode: scriptMember.mode,
          path: "scripts/run.sh",
          type: "file",
        },
      ],
      id: "review-pr",
    };
    const expectedFingerprint = sha(JSON.stringify(historicalInput));

    const desired = await buildDesiredState(home, { checkHostCapability: false });
    const skillFingerprint = desired.installations[0]?.artifactFingerprints.find(
      (fingerprint) => fingerprint.reference.id === "review-pr",
    )?.fingerprint;
    expect(skillFingerprint).toBe(expectedFingerprint);
  });
});
